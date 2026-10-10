import sharp from "sharp";
import { z } from "zod";
import { TerrainFile, type Building } from "../schema.js";
import type { WorldDef } from "./worlds.js";

const Vec3 = z.object({ X: z.number(), Y: z.number(), Z: z.number() });
const Rotation = z.object({ Pitch: z.number().optional(), Yaw: z.number().optional(), Roll: z.number().optional() }).nullable().optional();

/** A runtime virtual texture volume: the unit box [0,1]^3 scaled by `scale` and moved to `location`. */
const RvtVolume = z.object({
  virtualTexture: z.string().nullable().optional(),
  streamingTexture: z.string().nullable().optional(),
  location: Vec3,
  rotation: Rotation,
  scale: Vec3,
});
export type RvtVolume = z.infer<typeof RvtVolume>;

export const parseRvtVolumes = (text: string): RvtVolume[] => z.array(RvtVolume).parse(JSON.parse(text));

/** `Wardogs/Content/Maps/...uasset` to the in-game object path `/Game/Maps/...`. */
export const gamePath = (pkg: string): string => pkg.replace(/^Wardogs\/Content\//, "/Game/").replace(/\.(uasset|umap)$/, "");

/** The volume that places a world's baked height texture, matched by the texture it streams. */
export function findHeightVolume(volumes: readonly RvtVolume[], texturePackage: string): RvtVolume {
  const wanted = gamePath(texturePackage);
  const found = volumes.filter((v) => v.streamingTexture?.replace(/\.\d+$/, "") === wanted);
  if (found.length !== 1) throw new Error(`Expected one volume streaming ${wanted}, found ${found.length}.`);
  return found[0] as RvtVolume;
}

const toMeters = (cm: number): number => Math.round(cm) / 100;
const round2 = (v: number): number => Math.round(v * 100) / 100;
const round9 = (v: number): number => Math.round(v * 1e9) / 1e9;

export interface Heightmap {
  width: number;
  height: number;
  data: Uint16Array;
}

/**
 * Reads a 16-bit grayscale PNG with its full precision. Sharp converts 16-bit grayscale to 8-bit RGB unless the
 * colourspace is forced, which would silently destroy the heights (values would top out at 255).
 */
export async function loadHeightmap(pngPath: string): Promise<Heightmap> {
  const { data, info } = await sharp(pngPath, { limitInputPixels: false }).toColourspace("grey16").raw({ depth: "ushort" }).toBuffer({ resolveWithObject: true });
  if (info.channels !== 1 || data.byteLength !== info.width * info.height * 2) {
    throw new Error(`Expected a 1-channel 16-bit image, got ${info.channels} channels and ${data.byteLength} bytes for ${info.width}x${info.height}.`);
  }
  // Copy so the view is aligned; a Buffer slice may start at an odd offset.
  const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return { width: info.width, height: info.height, data: new Uint16Array(copy) };
}

type Geo = Pick<TerrainFile, "bounds" | "zRange"> & { heightmap: Pick<TerrainFile["heightmap"], "width" | "height" | "metersPerPixel"> };

/** Terrain height (world Z, meters) at a world position, by bilinear interpolation. Positions outside are clamped. */
export function heightAt(terrain: Geo, hm: Heightmap, x: number, y: number): number {
  const px = (x - terrain.bounds.min[0]) / terrain.heightmap.metersPerPixel[0];
  const py = (y - terrain.bounds.min[1]) / terrain.heightmap.metersPerPixel[1];
  const x0 = Math.min(Math.max(Math.floor(px), 0), hm.width - 2);
  const y0 = Math.min(Math.max(Math.floor(py), 0), hm.height - 2);
  const fx = Math.min(Math.max(px - x0, 0), 1);
  const fy = Math.min(Math.max(py - y0, 0), 1);
  const v = (ix: number, iy: number) => hm.data[iy * hm.width + ix] as number;
  const value = v(x0, y0) * (1 - fx) * (1 - fy) + v(x0 + 1, y0) * fx * (1 - fy) + v(x0, y0 + 1) * (1 - fx) * fy + v(x0 + 1, y0 + 1) * fx * fy;
  return terrain.zRange.min + (value / 65535) * (terrain.zRange.max - terrain.zRange.min);
}

export interface BuildingCheck {
  buildings: number;
  medianOffset: number;
  p5Offset: number;
  p95Offset: number;
  fractionWithin5m: number;
}

const percentile = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;

/** How far each building's lowest point is from the terrain under its centre. A correct decode keeps this small. */
export function checkBuildingsOnTerrain(terrain: Geo, hm: Heightmap, buildings: readonly Building[]): BuildingCheck {
  const offsets = buildings
    .map((b) => b.min[2] - heightAt(terrain, hm, (b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2))
    .sort((a, b) => a - b);
  return {
    buildings: offsets.length,
    medianOffset: round2(percentile(offsets, 0.5)),
    p5Offset: round2(percentile(offsets, 0.05)),
    p95Offset: round2(percentile(offsets, 0.95)),
    fractionWithin5m: offsets.length ? round2(offsets.filter((o) => Math.abs(o) <= 5).length / offsets.length) : 0,
  };
}

/** Limits for the self-check. Kavkazi measures a median of -1.3 m with 98% within 3 m; a wrong decode misses by 100 m or more. */
export const MAX_MEDIAN_OFFSET_M = 3;
export const MIN_FRACTION_WITHIN_5M = 0.9;
/** Below this many buildings the statistics mean little, so the check is skipped. */
export const MIN_BUILDINGS_FOR_CHECK = 20;

export function assertBuildingsOnTerrain(id: string, check: BuildingCheck): void {
  if (check.buildings < MIN_BUILDINGS_FOR_CHECK) return;
  if (Math.abs(check.medianOffset) > MAX_MEDIAN_OFFSET_M || check.fractionWithin5m < MIN_FRACTION_WITHIN_5M) {
    throw new Error(
      `${id}: buildings do not sit on the decoded terrain (median offset ${check.medianOffset} m, ${Math.round(check.fractionWithin5m * 100)}% within 5 m). ` +
        "The height encoding, volume transform or image orientation is wrong.",
    );
  }
}

export function buildTerrain(world: WorldDef, volume: RvtVolume, image: { width: number; height: number }, gameBuild: string, check: BuildingCheck): TerrainFile {
  const r = volume.rotation;
  if ([r?.Pitch, r?.Yaw, r?.Roll].some((a) => a !== undefined && Math.abs(a) > 1e-6)) {
    throw new Error(`${world.id}: the height volume is rotated; the heightmap would not be axis-aligned.`);
  }
  const { location: loc, scale } = volume;
  return TerrainFile.parse({
    schemaVersion: 1,
    id: world.id,
    world: world.folder,
    gameBuild,
    units: "meters",
    bounds: { min: [toMeters(loc.X), toMeters(loc.Y)], max: [toMeters(loc.X + scale.X), toMeters(loc.Y + scale.Y)] },
    zRange: { min: toMeters(loc.Z), max: toMeters(loc.Z + scale.Z) },
    heightmap: {
      file: "heightmap.png",
      width: image.width,
      height: image.height,
      bitDepth: 16,
      // Rounding to 0.01 m would drift by tens of meters across an 8192 px image. Nine decimals only removes float noise.
      metersPerPixel: [round9(scale.X / 100 / image.width), round9(scale.Y / 100 / image.height)],
      encoding: "z = zRange.min + value / 65535 * (zRange.max - zRange.min)",
    },
    check,
  });
}
