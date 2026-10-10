import { describe, expect, it } from "vitest";
import { buildBuildings, buildBuildingsFile, buildingKind, buildingsToGeoJson, parsePartRows, type PartRow } from "../src/maps/buildings.js";
import { BuildingsFile } from "../src/schema.js";

const owner = (actor: string, cls: string): PartRow => ({ t: "owner", actor, cls });
const part = (actor: string, origin: [number, number, number], extent?: [number, number, number]): PartRow => ({
  t: "part",
  actor,
  origin: { X: origin[0], Y: origin[1], Z: origin[2] },
  ...(extent ? { extent: { X: extent[0], Y: extent[1], Z: extent[2] } } : {}),
});

describe("buildingKind", () => {
  it("maps classes to kinds", () => {
    expect(buildingKind("B_Residential_Bungalow_01_C")).toBe("bungalow");
    expect(buildingKind("B_Residential_House_03_C")).toBe("house");
    expect(buildingKind("B_Apartment_Building_01_A_C")).toBe("apartment");
    expect(buildingKind("BP_Warehouse_Small_Hut_01a_C")).toBe("warehouse");
    expect(buildingKind("BP_MarketBuilding_04a_C")).toBe("market");
    expect(buildingKind("BP_Garage_Closed_01a_C")).toBe("garage");
    expect(buildingKind("B_Office_01_A_C")).toBe("office");
    expect(buildingKind("B_SupplyBuilding_02_C")).toBe("supply");
    expect(buildingKind("B_SwimPool_Building_01_C")).toBe("pool");
    expect(buildingKind("B_Fence_C")).toBeNull();
  });
});

describe("buildBuildings", () => {
  const rows: PartRow[] = [
    owner("house-a", "B_Residential_House_01_C"),
    owner("door-a", "B_Door_C"),
    owner("garage-door", "BP_Interactable_GarageDoor_01a_Left_C"),
    owner("fence", "B_Fence_C"),
    part("house-a", [1000, 2000, 300], [500, 400, 200]), // box 500..1500, 1600..2400, 100..500 (cm)
    part("house-a", [1400, 2000, 600], [300, 400, 250]), // box 1100..1700, 1600..2400, 350..850
    part("house-a", [0, 0, 0]), // no size: skipped
    part("door-a", [5, 5, 5], [1, 1, 1]),
    part("garage-door", [5, 5, 5], [1, 1, 1]),
    part("fence", [5, 5, 5], [1, 1, 1]),
  ];

  it("merges a building's parts into one box in meters", () => {
    const { buildings, partsWithoutExtent } = buildBuildings(rows);
    expect(buildings).toHaveLength(1);
    expect(buildings[0]).toMatchObject({ kind: "house", class: "B_Residential_House_01_C", parts: 2, min: [5, 16, 1], max: [17, 24, 8.5] });
    expect(partsWithoutExtent).toBe(1);
  });

  it("keeps offices, supply buildings and pool buildings but not awnings", () => {
    const more: PartRow[] = [
      owner("office", "B_Office_01_A_C"), part("office", [0, 0, 0], [100, 100, 100]),
      owner("awning", "BP_Factory_Awning_01a_C"), part("awning", [0, 0, 0], [100, 100, 100]),
    ];
    expect(buildBuildings(more).buildings.map((b) => b.kind)).toEqual(["office"]);
  });

  it("ignores doors and non-building classes", () => {
    const { buildings } = buildBuildings(rows);
    expect(buildings.map((b) => b.class)).toEqual(["B_Residential_House_01_C"]);
  });

  it("gives stable ids and a stable order", () => {
    const more = [...rows, owner("house-b", "B_Residential_House_01_C"), part("house-b", [-1000, 0, 0], [100, 100, 100])];
    const a = buildBuildings(more).buildings;
    const b = buildBuildings([...more].reverse()).buildings;
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
    expect(a[0]?.min[0]).toBeLessThan(a[1]?.min[0] ?? 0); // sorted by x
    expect(a[0]?.id).toMatch(/^[0-9a-f]{12}$/);
  });

  it("produces a file that satisfies the schema", () => {
    const { buildings } = buildBuildings(rows);
    expect(() => BuildingsFile.parse(buildBuildingsFile("Test", "1", buildings))).not.toThrow();
  });

  it("handles a world with no buildings", () => {
    const file = buildBuildingsFile("Empty", "1", buildBuildings([]).buildings);
    expect(file.count).toBe(0);
  });
});

describe("buildingsToGeoJson", () => {
  it("emits closed rectangle footprints with height properties", () => {
    const { buildings } = buildBuildings([owner("h", "B_Residential_House_01_C"), part("h", [1000, 1000, 500], [200, 100, 300])]);
    const gj = buildingsToGeoJson("Test", "1", buildings);
    const f = gj.features[0];
    expect(gj.type).toBe("FeatureCollection");
    expect(f?.geometry.coordinates[0]).toEqual([[8, 9], [12, 9], [12, 11], [8, 11], [8, 9]]);
    expect(f?.properties).toMatchObject({ kind: "house", baseZ: 2, height: 6, minZ: 2, maxZ: 8 });
  });
});

describe("parsePartRows", () => {
  it("reads JSON lines and ignores blank lines", () => {
    expect(parsePartRows('{"t":"owner","actor":"a","cls":"X"}\n\n{"t":"part","actor":"a"}\n')).toHaveLength(2);
  });
});
