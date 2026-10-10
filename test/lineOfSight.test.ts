import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ballisticArc, firstObstruction, lineOfSight, loadWorld, pixelToWorld, segmentBoxEntry, worldToPixel, type Box, type Vec3 } from "../src/lib/index.js";
import { writePng16 } from "./png16.js";

const box = (min: Vec3, max: Vec3, id?: string): Box => ({ min, max, ...(id ? { id } : {}) });
const wall = box([-5, 40, 0], [5, 60, 20], "wall");

describe("segmentBoxEntry", () => {
  it("returns where the segment enters, as a fraction of its length", () => {
    expect(segmentBoxEntry([0, 0, 10], [0, 100, 10], wall)).toBeCloseTo(0.4);
  });

  it("returns null when the segment misses, stops short, or runs parallel outside", () => {
    expect(segmentBoxEntry([20, 0, 10], [20, 100, 10], wall)).toBeNull(); // passes beside it
    expect(segmentBoxEntry([0, 0, 10], [0, 30, 10], wall)).toBeNull(); // ends before it
    expect(segmentBoxEntry([0, 0, 30], [0, 100, 30], wall)).toBeNull(); // passes over it
    expect(segmentBoxEntry([0, 70, 10], [0, 100, 10], wall)).toBeNull(); // starts beyond it
  });

  it("enters at 0 when the segment starts inside the box", () => {
    expect(segmentBoxEntry([0, 50, 10], [0, 100, 10], wall)).toBe(0);
  });

  it("handles a diagonal through a corner region", () => {
    expect(segmentBoxEntry([-20, 20, 10], [20, 80, 10], wall)).not.toBeNull();
    expect(segmentBoxEntry([-20, 20, 10], [-20, 80, 10], wall)).toBeNull();
  });
});

describe("lineOfSight with buildings", () => {
  it("is blocked by a building in the way, and says which one and where", () => {
    const hit = firstObstruction([[0, 0, 10], [0, 100, 10]], { buildings: [wall] })!;
    expect(hit).toMatchObject({ kind: "building", id: "wall", distance: 40 });
    expect(hit.at[1]).toBeCloseTo(40);
  });

  it("is clear over the top and around the side", () => {
    expect(lineOfSight([0, 0, 30], [0, 100, 30], { buildings: [wall] })).toBe(true);
    expect(lineOfSight([10, 0, 10], [10, 100, 10], { buildings: [wall] })).toBe(true);
  });

  it("reports the nearest of several buildings", () => {
    const far = box([-5, 80, 0], [5, 90, 20], "far");
    expect(firstObstruction([[0, 0, 10], [0, 100, 10]], { buildings: [far, wall] })?.id).toBe("wall");
  });

  it("treats a start inside a box as the building's own: boxes overestimate, so only buildings the path enters later block", () => {
    expect(lineOfSight([0, 41, 10], [0, 100, 10], { buildings: [wall] })).toBe(true); // starts inside the box
    expect(lineOfSight([0, 41, 10], [0, 100, 10], { buildings: [wall, box([-5, 80, 0], [5, 90, 20], "second")] })).toBe(false); // but a second building still blocks
    expect(firstObstruction([[0, 41, 10], [0, 100, 10]], { buildings: [wall, box([-5, 80, 0], [5, 90, 20], "second")] })?.id).toBe("second");
  });
});

describe("lineOfSight with terrain", () => {
  // A ridge 30 m high across y in [45, 55], over flat ground at 0 m.
  const ridge = (_x: number, y: number) => (y >= 45 && y <= 55 ? 30 : 0);

  it("is blocked by a ridge higher than the line, and clear above it", () => {
    const low = firstObstruction([[0, 0, 5], [0, 100, 5]], { terrain: ridge })!;
    expect(low.kind).toBe("terrain");
    expect(low.distance).toBeGreaterThanOrEqual(45);
    expect(low.distance).toBeLessThanOrEqual(46);
    expect(lineOfSight([0, 0, 40], [0, 100, 40], { terrain: ridge })).toBe(true);
  });

  it("applies the clearance", () => {
    expect(lineOfSight([0, 0, 31], [0, 100, 31], { terrain: ridge, clearance: 0 })).toBe(true);
    expect(lineOfSight([0, 0, 31], [0, 100, 31], { terrain: ridge, clearance: 2 })).toBe(false);
  });

  it("does not count ground under the endpoints", () => {
    const flat = () => 10;
    expect(lineOfSight([0, 0, 10], [0, 100, 10], { terrain: flat })).toBe(true); // both ends stand on the ground
    expect(lineOfSight([0, 0, 10], [0, 100, 10], { terrain: flat, endpointMargin: 0 })).toBe(true); // equal height is not under it
    expect(lineOfSight([0, 0, 9], [0, 100, 9], { terrain: flat, endpointMargin: 0 })).toBe(false);
  });

  it("combines terrain and buildings and reports whichever comes first", () => {
    const hit = firstObstruction([[0, 0, 5], [0, 100, 5]], { terrain: ridge, buildings: [wall] })!;
    expect(hit.kind).toBe("building"); // the wall at 40 m comes before the ridge at 45 m
  });

  it("rejects a step that is not positive and handles degenerate paths", () => {
    expect(() => firstObstruction([[0, 0, 0], [1, 1, 1]], { step: 0 })).toThrow(/step/);
    expect(firstObstruction([[0, 0, 0]])).toBeNull();
    expect(firstObstruction([[5, 5, 5], [5, 5, 5]], { buildings: [wall] })).toBeNull();
  });
});

describe("ballisticArc", () => {
  it("starts and ends at the given points with the apex exactly the rise above the higher end", () => {
    const arc = ballisticArc([0, 0, 0], [0, 1000, 50], 200, 200);
    expect(arc[0]).toEqual([0, 0, 0]);
    expect(arc.at(-1)).toEqual([0, 1000, 50]);
    expect(Math.max(...arc.map((p) => p[2]))).toBeCloseTo(250, 0);
  });

  it("is symmetric between level ends", () => {
    const arc = ballisticArc([0, 0, 10], [100, 0, 10], 20, 10);
    expect(arc[5]![2]).toBeCloseTo(30);
    expect(arc[3]![2]).toBeCloseTo(arc[7]![2]);
  });

  it("is a straight line when the rise is zero between level ends, and rejects bad arguments", () => {
    expect(ballisticArc([0, 0, 5], [10, 0, 5], 0, 4).map((p) => p[2])).toEqual([5, 5, 5, 5, 5]);
    expect(() => ballisticArc([0, 0, 0], [1, 0, 0], -1)).toThrow();
    expect(() => ballisticArc([0, 0, 0], [1, 0, 0], 1, 1)).toThrow();
  });

  it("clears a ridge that a flat line cannot, which is the point of artillery", () => {
    const ridge = (_x: number, y: number) => (y >= 450 && y <= 550 ? 80 : 0);
    const from: Vec3 = [0, 0, 2];
    const to: Vec3 = [0, 1000, 2];
    expect(lineOfSight(from, to, { terrain: ridge })).toBe(false);
    expect(firstObstruction(ballisticArc(from, to, 200), { terrain: ridge })).toBeNull();
    expect(firstObstruction(ballisticArc(from, to, 20), { terrain: ridge })?.kind).toBe("terrain");
  });
});

describe("worldToPixel and pixelToWorld", () => {
  const map = { bounds: { min: [-1632, -2040] as [number, number], max: [0, -408] as [number, number] }, image: { metersPerPixel: 2 } } as never;

  it("maps the minimum corner to pixel 0 and rows grow with world Y", () => {
    expect(worldToPixel(map, -1632, -2040)).toEqual([0, 0]);
    expect(worldToPixel(map, -1630, -2036)).toEqual([1, 2]);
  });

  it("round-trips", () => {
    const [px, py] = worldToPixel(map, -800.5, -1200.25);
    expect(pixelToWorld(map, px, py)).toEqual([-800.5, -1200.25]);
  });
});

describe("loadWorld", () => {
  it("loads a world's boxes and a ground height from the heightmap", async () => {
    const root = mkdtempSync(join(tmpdir(), "wardogs-world-"));
    const put = (path: string, value: unknown) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), JSON.stringify(value));
    };
    put("data/maps/w/map.json", {
      schemaVersion: 1, id: "w", name: "W", world: "W", gameBuild: "1", units: "meters",
      bounds: { min: [0, 0], max: [64, 64] },
      image: { width: 512, height: 512, metersPerPixel: 0.125, padding: { right: 0, bottom: 0 } },
      tiles: { size: 256, minZoom: 0, maxZoom: 1, format: "webp", urlTemplate: "tiles/{z}/{x}/{y}.webp" },
    });
    put("data/maps/w/terrain.json", {
      schemaVersion: 1, id: "w", world: "W", gameBuild: "1", units: "meters",
      bounds: { min: [0, 0], max: [64, 64] }, zRange: { min: -100, max: 100 },
      heightmap: { file: "heightmap.png", width: 64, height: 64, bitDepth: 16, metersPerPixel: [1, 1], encoding: "z = zRange.min + value / 65535 * (zRange.max - zRange.min)" },
      check: { buildings: 1, medianOffset: 0, p5Offset: 0, p95Offset: 0, fractionWithin5m: 1 },
    });
    put("data/maps/w/buildings.json", {
      schemaVersion: 1, world: "W", gameBuild: "1", units: "meters", shape: "axis-aligned bounding box", count: 1,
      buildings: [{ id: "abcdef012345", kind: "house", class: "B_House_C", min: [10, 10, 0], max: [20, 20, 9], parts: 3 }],
    });
    mkdirSync(join(root, "dist/maps/w"), { recursive: true });
    writePng16(join(root, "dist/maps/w/heightmap.png"), 64, 64, new Uint16Array(64 * 64).fill(49151)); // 49151 / 65535 = 0.75 -> +50 m
    const world = await loadWorld("w", join(root, "data"), join(root, "dist"));
    expect(world.groundHeight(30, 30)).toBeCloseTo(50, 1);
    expect(world.buildings).toEqual([{ id: "abcdef012345", min: [10, 10, 0], max: [20, 20, 9] }]);
    expect(lineOfSight([0, 15, 55], [30, 15, 55], { terrain: world.groundHeight, buildings: world.buildings })).toBe(true);
    expect(lineOfSight([0, 15, 5], [30, 15, 5], { buildings: world.buildings })).toBe(false);
  });
});
