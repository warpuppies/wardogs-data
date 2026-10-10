import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldObjectsFile, MapFile, TerrainFile } from "../src/schema.js";
import { buildWorldObjects, kindOf, OBJECT_CLASS_PATTERN, OBJECT_CLASSES, objectId, parseActor, parseActorLines } from "../src/maps/worldObjects.js";
import { WORLDS } from "../src/maps/worlds.js";

const line = (over: Record<string, unknown> = {}) => ({
  cls: "B_EquipmentVendor_C",
  name: "B_EquipmentVendor_C_UAID_1",
  package: "Wardogs/Content/Maps/Worlds/W/_Generated_/AAA.umap",
  location: { X: -770307.25, Y: -733942.25, Z: -84165.34 },
  rotation: { Pitch: 0, Yaw: 90, Roll: 0 },
  scale: { X: 1, Y: 1, Z: 1 },
  props: {},
  ...over,
});

describe("kindOf and the class pattern", () => {
  it("classifies the declared classes and nothing else", () => {
    expect(kindOf("B_EquipmentVendor_C")).toBe("equipment-vendor");
    expect(kindOf("B_VehicleDeploymentBoard_Manticore_C")).toBe("vehicle-deployment-board");
    expect(kindOf("WDSpawnVolume")).toBe("spawn-volume");
    expect(kindOf("B_Door_C")).toBeUndefined();
    expect(kindOf("B_EquipmentVendor_C_Extra")).toBeUndefined();
  });

  it("builds the extractor pattern from the same list", () => {
    const re = new RegExp(OBJECT_CLASS_PATTERN, "i");
    for (const c of OBJECT_CLASSES) expect(re.test(c.kind === "vehicle-deployment-board" ? "B_VehicleDeploymentBoard_X_C" : c.pattern.source.replace(/[\^$]/g, "")), c.kind).toBe(true);
    expect(re.test("B_Door_C")).toBe(false);
    expect(re.test("B_SafeZone_C_Child")).toBe(false);
  });
});

describe("parseActor", () => {
  it("converts to meters and keeps heading", () => {
    expect(parseActor(line())).toMatchObject({ kind: "equipment-vendor", class: "B_EquipmentVendor_C", position: [-7703.0725, -7339.4225, -841.6534], yaw: 90 });
  });

  it("omits unit scale and zero heading, keeps other scales and the faction", () => {
    const plain = parseActor(line({ rotation: { Pitch: 0, Yaw: 0, Roll: 0 } }))!;
    expect(plain).not.toHaveProperty("yaw");
    expect(plain).not.toHaveProperty("scale");
    expect(plain).not.toHaveProperty("faction");
    const zone = parseActor(line({ cls: "B_SafeZone_C", scale: { X: 750, Y: 750, Z: 750 }, props: { FactionTag: { TagName: "Meta.Alignment.Faction.Bravo" }, TagsToApply: ["State.Location.SafeZone.Bravo"] } }))!;
    expect(zone).toMatchObject({ kind: "safe-zone", scale: [750, 750, 750], faction: "Bravo", tags: ["State.Location.SafeZone.Bravo"] });
  });

  it("reads which vehicles a spawn volume allows and refuses", () => {
    const volume = parseActor(line({ cls: "WDSpawnVolume", props: { AllowedObjectsToSpawn: ["Vehicle.Variant.Land.Wheeled.Bobcat"], DisallowedObjectsToSpawn: ["Vehicle.Variant.Air.Rotary"] } }))!;
    expect(volume.allowedVehicles).toEqual(["Vehicle.Variant.Land.Wheeled.Bobcat"]);
    expect(volume.disallowedVehicles).toEqual(["Vehicle.Variant.Air.Rotary"]);
  });

  it("returns null for an unknown class or an actor without a position", () => {
    expect(parseActor(line({ cls: "B_Door_C" }))).toBeNull();
    expect(parseActor(line({ location: null }))).toBeNull();
  });

  it("makes the same id for the same actor and a different one otherwise", () => {
    expect(objectId(line())).toMatch(/^[0-9a-f]{12}$/);
    expect(objectId(line())).toBe(objectId(line()));
    expect(objectId(line())).not.toBe(objectId(line({ name: "other" })));
  });
});

describe("parseActorLines and buildWorldObjects", () => {
  const text = [
    JSON.stringify(line({ cls: "B_SafeZone_C", name: "z", location: { X: 0, Y: 0, Z: 0 } })),
    "not json",
    JSON.stringify(line({ name: "b", location: { X: 200, Y: 0, Z: 0 } })),
    JSON.stringify(line({ name: "a", location: { X: 100, Y: 0, Z: 0 } })),
    JSON.stringify(line({ cls: "B_Door_C" })),
    "",
  ].join("\n");

  it("sorts by kind then position, and counts skipped lines", () => {
    const { objects, skipped } = parseActorLines(text);
    expect(objects.map((o) => [o.kind, o.position[0]])).toEqual([["equipment-vendor", 1], ["equipment-vendor", 2], ["safe-zone", 0]]);
    expect(skipped).toBe(2);
  });

  it("writes a validated file for the world with kind counts", () => {
    const { file, counts } = buildWorldObjects(WORLDS[0]!, text, "5");
    expect(file.path).toBe(`data/maps/${WORLDS[0]!.id}/objects.json`);
    const parsed = WorldObjectsFile.parse(JSON.parse(file.content));
    expect(parsed.count).toBe(3);
    expect(counts).toEqual({ "equipment-vendor": 2, "safe-zone": 1 });
    expect(buildWorldObjects(WORLDS[0]!, text, "5").file.content).toBe(file.content);
  });
});

/** Checks of the committed data against the world's own map and terrain files. */
describe.each(WORLDS)("data/maps/$id/objects.json", (w) => {
  const read = (name: string): unknown => JSON.parse(readFileSync(join("data", "maps", w.id, name), "utf8"));
  const objects = WorldObjectsFile.parse(read("objects.json"));
  const map = MapFile.parse(read("map.json"));
  const terrain = TerrainFile.parse(read("terrain.json"));

  it("lists objects with unique ids", () => {
    expect(objects.world).toBe(w.folder);
    expect(objects.count).toBe(objects.objects.length);
    expect(new Set(objects.objects.map((o) => o.id)).size).toBe(objects.count);
  });

  it("has the basics of a match: shops, safe zones and spawns", () => {
    const kinds = new Set(objects.objects.map((o) => o.kind));
    for (const k of ["equipment-vendor", "vehicle-vendor", "safe-zone", "spawn-manager"] as const) expect(kinds.has(k), `${w.id} ${k}`).toBe(true);
  });

  it("puts every object on the map", () => {
    for (const o of objects.objects) {
      expect(o.position[0], o.id).toBeGreaterThan(map.bounds.min[0]);
      expect(o.position[0], o.id).toBeLessThan(map.bounds.max[0]);
      expect(o.position[1], o.id).toBeGreaterThan(map.bounds.min[1]);
      expect(o.position[1], o.id).toBeLessThan(map.bounds.max[1]);
    }
  });

  it("puts every object within the world's height range, with some slack for tall structures", () => {
    for (const o of objects.objects) {
      expect(o.position[2], o.id).toBeGreaterThan(terrain.zRange.min - 50);
      expect(o.position[2], o.id).toBeLessThan(terrain.zRange.max + 100);
    }
  });
});
