import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertBuildingsOnTerrain,
  buildTerrain,
  checkBuildingsOnTerrain,
  findHeightVolume,
  gamePath,
  heightAt,
  loadHeightmap,
  parseRvtVolumes,
  type Heightmap,
  type RvtVolume,
} from "../src/maps/terrain.js";
import type { WorldDef } from "../src/maps/worlds.js";
import type { Building } from "../src/schema.js";
import { writePng16 } from "./png16.js";

const world: WorldDef = { id: "test", folder: "Test", serverRow: "T", heightTexture: "Wardogs/Content/Maps/Worlds/Test/Landscape/SVT_Test_Height.uasset" };
const volume = (over: Partial<RvtVolume> = {}): RvtVolume => ({
  virtualTexture: "RuntimeVirtualTexture'H'",
  streamingTexture: "/Game/Maps/Worlds/Test/Landscape/SVT_Test_Height.1",
  location: { X: -10000, Y: -20000, Z: -50000 },
  rotation: null,
  scale: { X: 20000, Y: 20000, Z: 100000 },
  ...over,
});
const geo = (width = 4, height = 4) => ({
  bounds: { min: [-100, -200] as [number, number], max: [100, 0] as [number, number] },
  zRange: { min: -500, max: 500 },
  heightmap: { width, height, metersPerPixel: [200 / width, 200 / height] as [number, number] },
});

describe("gamePath / findHeightVolume", () => {
  it("converts package paths to in-game object paths", () => {
    expect(gamePath("Wardogs/Content/Maps/Worlds/Test/A.uasset")).toBe("/Game/Maps/Worlds/Test/A");
  });

  it("finds the volume that streams the world's height texture", () => {
    const other = volume({ streamingTexture: "/Game/Maps/Worlds/Test/Other.1" });
    expect(findHeightVolume([other, volume()], world.heightTexture)).toEqual(volume());
  });

  it("fails if no volume or more than one matches", () => {
    expect(() => findHeightVolume([], world.heightTexture)).toThrow(/found 0/);
    expect(() => findHeightVolume([volume(), volume()], world.heightTexture)).toThrow(/found 2/);
  });
});

describe("parseRvtVolumes", () => {
  it("reads the extractor's JSON", () => {
    expect(parseRvtVolumes(JSON.stringify([volume()]))).toHaveLength(1);
  });
  it("rejects malformed rows", () => {
    expect(() => parseRvtVolumes('[{"location":{}}]')).toThrow();
  });
});

describe("buildTerrain", () => {
  const check = { buildings: 0, medianOffset: 0, p5Offset: 0, p95Offset: 0, fractionWithin5m: 0 };

  it("derives bounds, Z range and resolution in meters", () => {
    const t = buildTerrain(world, volume(), { width: 100, height: 100 }, "7", check);
    expect(t.bounds).toEqual({ min: [-100, -200], max: [100, 0] });
    expect(t.zRange).toEqual({ min: -500, max: 500 });
    expect(t.heightmap.metersPerPixel).toEqual([2, 2]);
    expect(t.units).toBe("meters");
  });

  it("keeps meters-per-pixel exact instead of rounding it", () => {
    // 16,320 m over 8192 px is 1.9921875 exactly. Rounded to 1.99 it would drift by about 18 m across the image.
    const t = buildTerrain(world, volume({ scale: { X: 1632000, Y: 1632000, Z: 100000 } }), { width: 8192, height: 8192 }, "7", check);
    expect(t.heightmap.metersPerPixel).toEqual([1.9921875, 1.9921875]);
  });

  it("rejects a rotated volume", () => {
    expect(() => buildTerrain(world, volume({ rotation: { Yaw: 15 } }), { width: 100, height: 100 }, "7", check)).toThrow(/rotated/);
  });
});

describe("heightAt", () => {
  const t = geo(2, 2);
  const hm: Heightmap = { width: 2, height: 2, data: Uint16Array.from([0, 65535, 0, 65535]) }; // left column low, right high

  it("decodes pixel values across the Z range", () => {
    expect(heightAt(t, hm, -100, -200)).toBeCloseTo(-500, 6);
    expect(heightAt(t, hm, 0, -200)).toBeCloseTo(500, 6);
  });

  it("interpolates between pixels", () => {
    expect(heightAt(t, hm, -50, -100)).toBeCloseTo(0, 6);
  });

  it("clamps positions outside the bounds", () => {
    expect(heightAt(t, hm, -9999, -9999)).toBeCloseTo(-500, 6);
    expect(heightAt(t, hm, 9999, 9999)).toBeCloseTo(500, 6);
  });

  it("has rows that increase with world Y", () => {
    const rows: Heightmap = { width: 2, height: 2, data: Uint16Array.from([0, 0, 65535, 65535]) }; // top row low, bottom row high
    expect(heightAt(t, rows, -100, -200)).toBeCloseTo(-500, 6); // minimum Y is the first row
    expect(heightAt(t, rows, -100, 0)).toBeCloseTo(500, 6);
  });
});

describe("loadHeightmap", () => {
  it("keeps the full 16-bit precision (sharp would otherwise reduce it to 8-bit)", async () => {
    const values = Uint16Array.from([0, 1, 255, 256, 12345, 40000, 65534, 65535, 100, 200, 300, 400, 500, 600, 700, 800]);
    const file = join(mkdtempSync(join(tmpdir(), "wardogs-h-")), "h.png");
    writePng16(file, 4, 4, values);
    const hm = await loadHeightmap(file);
    expect([hm.width, hm.height]).toEqual([4, 4]);
    expect([...hm.data]).toEqual([...values]);
  });
});

describe("buildings-on-terrain check", () => {
  const flat: Heightmap = { width: 4, height: 4, data: new Uint16Array(16).fill(32768) }; // z of about 0 m
  const building = (z: number, x = 0): Building => ({ id: "0123456789ab", kind: "house", class: "B_House_C", min: [x, -100, z], max: [x + 10, -90, z + 8], parts: 1 });
  const t = geo();

  it("reports offsets in meters", () => {
    const c = checkBuildingsOnTerrain(t, flat, [building(-1.5), building(-1.5, 20), building(-1.5, 40)]);
    expect(c.buildings).toBe(3);
    expect(c.medianOffset).toBeCloseTo(-1.5, 1);
    expect(c.fractionWithin5m).toBe(1);
  });

  it("accepts a plausible decode", () => {
    const many = Array.from({ length: 30 }, (_, i) => building(-1 + (i % 3) * 0.5, i));
    expect(() => assertBuildingsOnTerrain("w", checkBuildingsOnTerrain(t, flat, many))).not.toThrow();
  });

  it("rejects a decode that puts the terrain far from the buildings", () => {
    const many = Array.from({ length: 30 }, (_, i) => building(150, i));
    expect(() => assertBuildingsOnTerrain("w", checkBuildingsOnTerrain(t, flat, many))).toThrow(/do not sit on the decoded terrain/);
  });

  it("skips the check when there are too few buildings", () => {
    expect(() => assertBuildingsOnTerrain("w", checkBuildingsOnTerrain(t, flat, [building(900)]))).not.toThrow();
  });
});
