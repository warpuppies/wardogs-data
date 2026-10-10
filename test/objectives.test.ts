import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildObjectives, classifyConfig, parseControlZoneConfig, parseZone } from "../src/maps/objectives.js";
import { WORLDS } from "../src/maps/worlds.js";
import { MapFile, ObjectivesFile, TerrainFile } from "../src/schema.js";
import type { RawExport } from "../src/transform/items.js";

const zoneData = (x: number, y: number, z: number, extent = 50000) => ({
  ControlZoneActorLocation: { X: x, Y: y, Z: z },
  ZoneScaledExtents: { X: extent, Y: extent, Z: 17000 },
  ZoneShape: "EWDZoneShape::Cylinder",
});
const config = (props: Record<string, unknown>): RawExport => ({ Type: "WDControlZoneConfigDataAsset", Properties: props as never });

describe("classifyConfig", () => {
  it("finds the world and the mode from the asset name", () => {
    expect(classifyConfig("DA_ControlZoneConfig_Bakurani")).toEqual({ world: "kavkazi", mode: "Standard" });
    expect(classifyConfig("DA_ControlZoneConfig_SniperShowdown_Bakurani")).toEqual({ world: "kavkazi", mode: "SniperShowdown" });
    expect(classifyConfig("DA_ControlZone_Config_Europe")).toEqual({ world: "europe", mode: "Standard" });
    expect(classifyConfig("DA_ControlZone_Config_NorthAmerica")).toEqual({ world: "north-america", mode: "Standard" });
  });

  it("does not place a config for an unknown map or a different asset", () => {
    expect(classifyConfig("DA_ControlZoneConfig_Gym_Minimal")).toBeNull();
    expect(classifyConfig("DA_Something_Else")).toBeNull();
  });
});

describe("parseZone", () => {
  it("converts centimeters to meters and keeps shapes", () => {
    const zone = parseZone(zoneData(-836067.25, -1123312.1, -95160), { ZoneScaledExtents: { X: 8500, Y: 8500, Z: 17000 }, ZoneShape: "EWDZoneShape::Cylinder" });
    expect(zone).toEqual({
      center: [-8360.6725, -11233.121, -951.6],
      extents: [500, 500, 170],
      shape: "Cylinder",
      hotZone: { extents: [85, 85, 170], shape: "Cylinder" },
    });
  });

  it("leaves the shape out when the game does not state it, and rejects a zone without a position", () => {
    const zone = parseZone({ ControlZoneActorLocation: { X: 0, Y: 0, Z: 0 }, ZoneScaledExtents: { X: 100, Y: 100, Z: 100 } }, { ZoneScaledExtents: { X: 10, Y: 10, Z: 10 } });
    expect(zone).not.toHaveProperty("shape");
    expect(zone?.hotZone).not.toHaveProperty("shape");
    expect(parseZone({ ZoneScaledExtents: { X: 1, Y: 1, Z: 1 } }, undefined)).toBeNull();
    expect(parseZone(undefined, undefined)).toBeNull();
  });
});

describe("parseControlZoneConfig", () => {
  const exp = config({
    ZoneData: { ControlZoneData: zoneData(100, 200, 300), HotZoneData: { ZoneScaledExtents: { X: 10, Y: 10, Z: 10 } } },
    AlternatorZoneData: [
      { AlternatorTag: { TagName: "ZoneAlternator.Test.A.Circle" }, AlternatorSelectionWeight: 2, ControlZoneData: zoneData(1000, 2000, 3000), HotZoneData: { ZoneScaledExtents: { X: 10, Y: 10, Z: 10 } } },
      { AlternatorTag: { TagName: "ZoneAlternator.Test.B.Circle" }, ControlZoneData: zoneData(5000, 6000, 7000) },
      { AlternatorTag: { TagName: "ZoneAlternator.Test.Broken" } },
    ],
    HotZoneMovementData: { MoveDelay: 25, HotZoneInnerRadiusPercentage: 0.95, DefaultSpeed: 1, bUseDynamicHotzoneSpeeds: true, HotzoneSpeeds: [0.75, 1, "x"], MinHotZoneMoveDistance: 750 },
  });

  it("reads the default zone, the weighted alternatives and the hot zone movement", () => {
    const c = parseControlZoneConfig("DA_ControlZoneConfig_Bakurani", exp)!;
    expect(c.zone.center).toEqual([1, 2, 3]);
    expect(c.alternatives.map((a) => [a.id, a.weight, a.zone.center])).toEqual([
      ["ZoneAlternator.Test.A.Circle", 2, [10, 20, 30]],
      ["ZoneAlternator.Test.B.Circle", 1, [50, 60, 70]], // no weight stated: the game's default weight is 1
    ]);
    expect(c.hotZoneMovement).toEqual({ moveDelay: 25, innerRadiusFraction: 0.95, defaultSpeed: 1, dynamicSpeeds: true, speeds: [0.75, 1], minMoveDistance: 7.5 });
  });

  it("returns null for an unplaced config or one without a default zone", () => {
    expect(parseControlZoneConfig("DA_ControlZoneConfig_Gym_Minimal", exp)).toBeNull();
    expect(parseControlZoneConfig("DA_ControlZoneConfig_Bakurani", config({}))).toBeNull();
  });
});

describe("buildObjectives", () => {
  const withZone = (x: number) => config({ ZoneData: { ControlZoneData: zoneData(x, 0, 0), HotZoneData: {} } });

  it("writes one file per world with configs, sorted, and lists what it could not place", () => {
    const { files, unplaced } = buildObjectives(
      [
        { name: "DA_ControlZoneConfig_SniperShowdown_Bakurani", export: withZone(2) },
        { name: "DA_ControlZoneConfig_Bakurani", export: withZone(1) },
        { name: "DA_ControlZoneConfig_Gym_Minimal", export: withZone(3) },
      ],
      WORLDS,
      "9",
    );
    expect(files.map((f) => f.path)).toEqual(["data/maps/kavkazi/objectives.json"]);
    const parsed = ObjectivesFile.parse(JSON.parse(files[0]!.content));
    expect(parsed.world).toBe("Kavkazi");
    expect(parsed.configs.map((c) => c.config)).toEqual(["DA_ControlZoneConfig_Bakurani", "DA_ControlZoneConfig_SniperShowdown_Bakurani"]);
    expect(unplaced).toEqual(["DA_ControlZoneConfig_Gym_Minimal"]);
  });
});

/** Checks of the committed data against the world's own map and terrain files. */
describe.each(WORLDS)("data/maps/$id/objectives.json", (w) => {
  const read = (name: string): unknown => JSON.parse(readFileSync(join("data", "maps", w.id, name), "utf8"));
  const objectives = ObjectivesFile.parse(read("objectives.json"));
  const map = MapFile.parse(read("map.json"));
  const terrain = TerrainFile.parse(read("terrain.json"));
  const zones = objectives.configs.flatMap((c) => [c.zone, ...c.alternatives.map((a) => a.zone)]);

  it("has a standard configuration", () => {
    expect(objectives.world).toBe(w.folder);
    expect(objectives.configs.some((c) => c.mode === "Standard")).toBe(true);
  });

  it("puts every control zone inside the map, with its whole circle on the map", () => {
    for (const z of zones) {
      const radius = z.extents[0];
      expect(z.center[0] - radius, `${w.id} ${z.center}`).toBeGreaterThan(map.bounds.min[0]);
      expect(z.center[0] + radius).toBeLessThan(map.bounds.max[0]);
      expect(z.center[1] - radius).toBeGreaterThan(map.bounds.min[1]);
      expect(z.center[1] + radius).toBeLessThan(map.bounds.max[1]);
    }
  });

  it("puts every control zone at a height the terrain has", () => {
    for (const z of zones) {
      expect(z.center[2]).toBeGreaterThan(terrain.zRange.min);
      expect(z.center[2]).toBeLessThan(terrain.zRange.max);
    }
  });

  it("keeps the hot zone smaller than the control zone", () => {
    for (const z of zones) expect(z.hotZone.extents[0]).toBeLessThan(z.extents[0]);
  });
});

describe("objectives: canaries", () => {
  it("Kavkazi's standard control zone is 500 m wide in radius, centered near (-8361, -11233), with three placements", () => {
    const kav = ObjectivesFile.parse(JSON.parse(readFileSync("data/maps/kavkazi/objectives.json", "utf8")));
    const standard = kav.configs.find((c) => c.mode === "Standard")!;
    expect(standard.zone.center[0]).toBeCloseTo(-8360.67, 1);
    expect(standard.zone.center[1]).toBeCloseTo(-11233.12, 1);
    expect(standard.zone.extents).toEqual([500, 500, 170]);
    expect(standard.zone.hotZone.extents).toEqual([85, 85, 170]);
    expect(standard.alternatives.map((a) => [a.id, a.weight])).toEqual([
      ["ZoneAlternator.Bakurani.Default.Circle", 2],
      ["ZoneAlternator.Bakurani.Farmland.Circle", 1],
      ["ZoneAlternator.Bakurani.Lumberyard.Circle", 1],
    ]);
    expect(standard.hotZoneMovement).toMatchObject({ moveDelay: 25, innerRadiusFraction: 0.95, speeds: [0.75, 1, 1.25, 1.5, 1.75, 2] });
  });
});
