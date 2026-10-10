import { describe, expect, it } from "vitest";
import { buildMap, DEFAULT_UNITS_PER_PIXEL, parseMapName, parseMinimapData, pixelToWorld, worldToPixel } from "../src/maps/mapMeta.js";
import type { WorldDef } from "../src/maps/worlds.js";
import type { RawExport } from "../src/transform/items.js";

const world: WorldDef = { id: "test", folder: "Test", serverRow: "Test_01", heightTexture: "Wardogs/Content/Maps/Worlds/Test/H.uasset" };
const asset = (sizeX: number, min: [number, number], max: [number, number], unitsPerPixel?: number): RawExport[] => [
  {
    Type: "WDMinimapTextureData",
    Properties: {
      SizeX: sizeX,
      ...(unitsPerPixel ? { WorldUnitsPerPixel: unitsPerPixel } : {}),
      Bounds: { Min: { X: min[0], Y: min[1] }, Max: { X: max[0], Y: max[1] } },
    },
  },
];

describe("parseMinimapData", () => {
  it("uses the explicit units per pixel", () => {
    expect(parseMinimapData(asset(16384, [0, 0], [1, 1], 100)).unitsPerPixel).toBe(100);
  });
  it("falls back to the class default when the property is omitted", () => {
    expect(parseMinimapData(asset(32768, [0, 0], [1, 1])).unitsPerPixel).toBe(DEFAULT_UNITS_PER_PIXEL);
  });
  it("rejects other assets", () => {
    expect(() => parseMinimapData([{ Type: "Other" }])).toThrow(/minimap/);
  });
});

describe("parseMapName", () => {
  const table: RawExport[] = [{ Type: "DataTable", Rows: { Test_01: { DisplayName: { CultureInvariantString: "Testville" } } } as never }];
  it("reads the display name", () => expect(parseMapName(table, "Test_01")).toBe("Testville"));
  it("fails loudly for a missing row", () => expect(() => parseMapName(table, "Nope")).toThrow(/Nope/));
});

describe("buildMap", () => {
  it("handles a world whose bounds are smaller than its image (padding)", () => {
    // 16384 px at 100 cm/px, bounds 16,320 m wide: 64 px of padding on the right and bottom.
    const m = buildMap(world, parseMinimapData(asset(16384, [-1632000, -2040000], [0, -408000], 100)), "T", "1", { width: 16384, height: 16384 });
    expect(m.image).toEqual({ width: 16384, height: 16384, metersPerPixel: 1, padding: { right: 64, bottom: 64 } });
    expect(m.bounds).toEqual({ min: [-16320, -20400], max: [0, -4080] });
    expect(m.tiles.maxZoom).toBe(6);
  });

  it("accounts for a downscaled export of a larger source texture", () => {
    // 32768 px source at the default 50 cm/px, exported at 16384: 1 m per exported pixel.
    const m = buildMap(world, parseMinimapData(asset(32768, [-1616000, -1616000], [16000, 16000])), "T", "1", { width: 16384, height: 16384 });
    expect(m.image.metersPerPixel).toBe(1);
    expect(m.image.padding).toEqual({ right: 64, bottom: 64 });
  });

  it("has no padding when the bounds fill the image", () => {
    const m = buildMap(world, parseMinimapData(asset(32768, [-819200, -819200], [819200, 819200])), "T", "1", { width: 16384, height: 16384 });
    expect(m.image.padding).toEqual({ right: 0, bottom: 0 });
  });

  it("rejects a units-per-pixel assumption that does not fit the bounds", () => {
    // Bounds twice as wide as the image can hold: negative padding.
    expect(() => buildMap(world, parseMinimapData(asset(16384, [0, 0], [3276800, 3276800], 100)), "T", "1", { width: 16384, height: 16384 })).toThrow(/padding/);
    // Bounds far smaller than the image: implausibly large padding.
    expect(() => buildMap(world, parseMinimapData(asset(16384, [0, 0], [819200, 819200], 100)), "T", "1", { width: 16384, height: 16384 })).toThrow(/padding/);
  });

  it("rejects images that cannot form a 256 px tile pyramid", () => {
    expect(() => buildMap(world, parseMinimapData(asset(1000, [0, 0], [100000, 100000], 100)), "T", "1", { width: 1000, height: 1000 })).toThrow(/256/);
    expect(() => buildMap(world, parseMinimapData(asset(1024, [0, 0], [100000, 100000], 100)), "T", "1", { width: 1024, height: 512 })).toThrow(/square/);
  });
});

describe("worldToPixel / pixelToWorld", () => {
  const map = { bounds: { min: [-100, -200] as [number, number], max: [0, 0] as [number, number] }, image: { width: 256, height: 256, metersPerPixel: 0.5, padding: { right: 0, bottom: 0 } } };
  it("maps the minimum corner to pixel (0, 0) and rows increase with Y", () => {
    expect(worldToPixel(map, -100, -200)).toEqual([0, 0]);
    expect(worldToPixel(map, -90, -190)).toEqual([20, 20]);
  });
  it("round-trips", () => {
    const [px, py] = worldToPixel(map, -37.5, -120.25);
    expect(pixelToWorld(map, px, py)).toEqual([-37.5, -120.25]);
  });
});
