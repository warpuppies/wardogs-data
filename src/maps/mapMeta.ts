import { MapFile } from "../schema.js";
import type { RawExport } from "../transform/items.js";
import type { WorldDef } from "./worlds.js";

/**
 * `WDMinimapTextureData.WorldUnitsPerPixel` default. The property is omitted when it equals the class default; the
 * two worlds that omit it only fit their bounds at 50 (Kavkazi sets 100 explicitly). `buildMap` rejects any
 * combination whose padding is negative or implausibly large, which would expose a wrong default.
 */
export const DEFAULT_UNITS_PER_PIXEL = 50;

export interface MinimapData {
  /** Width and height of the source texture in pixels. */
  sizeX: number;
  /** World units (centimeters) per source pixel. */
  unitsPerPixel: number;
  /** Capture bounds in world units. */
  min: [number, number];
  max: [number, number];
}

interface MinimapProps {
  SizeX?: number;
  WorldUnitsPerPixel?: number;
  Bounds?: { Min?: { X: number; Y: number }; Max?: { X: number; Y: number } };
}

export function parseMinimapData(exports: RawExport[]): MinimapData {
  const exp = exports.find((e) => e.Type === "WDMinimapTextureData");
  const p = (exp?.Properties ?? {}) as MinimapProps;
  if (!p.SizeX || !p.Bounds?.Min || !p.Bounds.Max) throw new Error("Not a minimap data asset (missing SizeX or Bounds).");
  return {
    sizeX: p.SizeX,
    unitsPerPixel: p.WorldUnitsPerPixel ?? DEFAULT_UNITS_PER_PIXEL,
    min: [p.Bounds.Min.X, p.Bounds.Min.Y],
    max: [p.Bounds.Max.X, p.Bounds.Max.Y],
  };
}

/** Reads a map's display name from the server-browser table. */
export function parseMapName(exports: RawExport[], serverRow: string): string {
  const table = exports.find((e) => e.Type === "DataTable");
  const row = (table?.Rows as Record<string, { DisplayName?: { CultureInvariantString?: string } }> | undefined)?.[serverRow];
  const name = row?.DisplayName?.CultureInvariantString;
  if (!name) throw new Error(`No map name for server-browser row ${serverRow}.`);
  return name;
}

const toMeters = (cm: number): number => Math.round(cm) / 100;

/** Padding larger than this fraction of the image means the units-per-pixel assumption is wrong. */
const MAX_PADDING_FRACTION = 0.01;

export function buildMap(
  world: WorldDef,
  minimap: MinimapData,
  name: string,
  gameBuild: string,
  image: { width: number; height: number },
): MapFile {
  const zoomExact = Math.log2(image.width / 256);
  if (image.width !== image.height || !Number.isInteger(zoomExact) || zoomExact < 0) {
    throw new Error(`${world.id}: image ${image.width}x${image.height} is not square with a size of 256 * 2^n.`);
  }

  // The exported image may be a downscaled mip of the source texture; keep meters-per-pixel in step with it.
  const metersPerPixel = (minimap.unitsPerPixel / 100) * (minimap.sizeX / image.width);
  const min: [number, number] = [toMeters(minimap.min[0]), toMeters(minimap.min[1])];
  const max: [number, number] = [toMeters(minimap.max[0]), toMeters(minimap.max[1])];
  const padding = {
    right: Math.round(image.width - (max[0] - min[0]) / metersPerPixel),
    bottom: Math.round(image.height - (max[1] - min[1]) / metersPerPixel),
  };
  for (const [side, px] of Object.entries(padding)) {
    if (px < 0 || px > image.width * MAX_PADDING_FRACTION) {
      throw new Error(`${world.id}: ${px}px of ${side} padding; bounds and units-per-pixel disagree.`);
    }
  }

  return MapFile.parse({
    schemaVersion: 1,
    id: world.id,
    name,
    world: world.folder,
    gameBuild,
    units: "meters",
    bounds: { min, max },
    image: { width: image.width, height: image.height, metersPerPixel, padding },
    tiles: { size: 256, minZoom: 0, maxZoom: zoomExact, format: "webp", urlTemplate: "tiles/{z}/{x}/{y}.webp" },
  });
}

/** World X/Y (meters) to pixel coordinates in the map image. Rows increase with world Y. */
export function worldToPixel(map: Pick<MapFile, "bounds" | "image">, x: number, y: number): [number, number] {
  return [(x - map.bounds.min[0]) / map.image.metersPerPixel, (y - map.bounds.min[1]) / map.image.metersPerPixel];
}

/** Pixel coordinates in the map image back to world X/Y (meters). */
export function pixelToWorld(map: Pick<MapFile, "bounds" | "image">, px: number, py: number): [number, number] {
  return [map.bounds.min[0] + px * map.image.metersPerPixel, map.bounds.min[1] + py * map.image.metersPerPixel];
}
