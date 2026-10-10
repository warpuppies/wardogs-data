import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { heightAt, loadHeightmap } from "../maps/terrain.js";
import { BuildingsFile, MapFile, TerrainFile } from "../schema.js";
import type { Box, HeightFn } from "./lineOfSight.js";

/** Pixel of a map image for a world position: `(world - bounds.min) / metersPerPixel`. Rows increase with world Y. */
export function worldToPixel(map: Pick<MapFile, "bounds" | "image">, x: number, y: number): [number, number] {
  return [(x - map.bounds.min[0]) / map.image.metersPerPixel, (y - map.bounds.min[1]) / map.image.metersPerPixel];
}

/** World position of a map image pixel. The inverse of `worldToPixel`. */
export function pixelToWorld(map: Pick<MapFile, "bounds" | "image">, px: number, py: number): [number, number] {
  return [map.bounds.min[0] + px * map.image.metersPerPixel, map.bounds.min[1] + py * map.image.metersPerPixel];
}

export interface World {
  id: string;
  map: MapFile;
  terrain: TerrainFile;
  /** Ground height in meters, bilinear on the heightmap. */
  groundHeight: HeightFn;
  /** Destructible buildings as boxes, for `lineOfSight`. */
  buildings: Box[];
}

/**
 * Loads a world for line-of-sight checks: its metadata and building boxes from `dataDir` (`data/`) and its heightmap
 * from `distDir` (`dist/`, built by `pnpm assets`) or, when it is not there, from the tracked copy in `assetsDir` (`assets/maps/`, written by `pnpm maps`).
 */
export async function loadWorld(id: string, dataDir = "data", distDir = "dist", assetsDir = "assets"): Promise<World> {
  const read = (name: string): unknown => JSON.parse(readFileSync(join(dataDir, "maps", id, name), "utf8"));
  const map = MapFile.parse(read("map.json"));
  const terrain = TerrainFile.parse(read("terrain.json"));
  const buildings = BuildingsFile.parse(read("buildings.json")).buildings.map((b): Box => ({ min: b.min, max: b.max, id: b.id }));
  const built = join(distDir, "maps", id, terrain.heightmap.file);
  const heightmap = await loadHeightmap(existsSync(built) ? built : join(assetsDir, "maps", id, terrain.heightmap.file));
  return { id, map, terrain, groundHeight: (x, y) => heightAt(terrain, heightmap, x, y), buildings };
}
