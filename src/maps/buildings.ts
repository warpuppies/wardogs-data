import { createHash } from "node:crypto";
import { BUILDING_KINDS, type Building, BuildingsFile } from "../schema.js";

/** Blueprint classes that are whole buildings. Declared here so the selection is reviewable and tested. */
export const BUILDING_CLASS = /(Bungalow|House|Apartment_Building|Warehouse|MarketBuilding|Market_Building|Shop|Garage_(Closed|Openable)|Office|SupplyBuilding|SwimPool_Building)/;
/** Doors and garage doors own destruction components too, but are parts of buildings, not buildings. */
export const NOT_A_BUILDING = /Door/i;

type Kind = (typeof BUILDING_KINDS)[number];
const KIND_RULES: ReadonlyArray<[RegExp, Kind]> = [
  [/Bungalow/, "bungalow"],
  [/House/, "house"],
  [/Apartment_Building/, "apartment"],
  [/Warehouse/, "warehouse"],
  [/Market/, "market"],
  [/Shop/, "shop"],
  [/Garage/, "garage"],
  [/Office/, "office"],
  [/SupplyBuilding/, "supply"],
  [/SwimPool_Building/, "pool"],
];

export function buildingKind(cls: string): Kind | null {
  return KIND_RULES.find(([re]) => re.test(cls))?.[1] ?? null;
}

interface Vec {
  X: number;
  Y: number;
  Z: number;
}
export type PartRow =
  | { t: "owner"; actor: string; cls?: string }
  | { t: "part"; actor: string; origin?: Vec; extent?: Vec };

export function parsePartRows(jsonl: string): PartRow[] {
  return jsonl
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as PartRow);
}

const meters = (cm: number): number => Math.round(cm) / 100;
const stableId = (actor: string): string => createHash("sha1").update(actor).digest("hex").slice(0, 12);

export interface BuildingsBuild {
  buildings: Building[];
  /** Parts skipped because their bounds carry no size. */
  partsWithoutExtent: number;
}

/**
 * Turns raw rows into one box per building: the union of the world-space bounds of its mesh parts, in meters.
 * Parts whose bounds have no size are skipped, so a building made only of such parts is dropped.
 */
export function buildBuildings(rows: readonly PartRow[]): BuildingsBuild {
  const classes = new Map<string, string>();
  for (const r of rows) if (r.t === "owner" && r.cls) classes.set(r.actor, r.cls);

  const boxes = new Map<string, { min: [number, number, number]; max: [number, number, number]; parts: number }>();
  let partsWithoutExtent = 0;
  for (const r of rows) {
    if (r.t !== "part") continue;
    const cls = classes.get(r.actor);
    if (!cls || !BUILDING_CLASS.test(cls) || NOT_A_BUILDING.test(cls)) continue;
    if (!r.origin || !r.extent) {
      partsWithoutExtent++;
      continue;
    }
    const lo: [number, number, number] = [r.origin.X - r.extent.X, r.origin.Y - r.extent.Y, r.origin.Z - r.extent.Z];
    const hi: [number, number, number] = [r.origin.X + r.extent.X, r.origin.Y + r.extent.Y, r.origin.Z + r.extent.Z];
    const box = boxes.get(r.actor);
    if (!box) boxes.set(r.actor, { min: lo, max: hi, parts: 1 });
    else {
      box.min = [Math.min(box.min[0], lo[0]), Math.min(box.min[1], lo[1]), Math.min(box.min[2], lo[2])];
      box.max = [Math.max(box.max[0], hi[0]), Math.max(box.max[1], hi[1]), Math.max(box.max[2], hi[2])];
      box.parts++;
    }
  }

  const buildings: Building[] = [];
  for (const [actor, box] of boxes) {
    const cls = classes.get(actor) as string;
    const kind = buildingKind(cls);
    if (!kind) continue;
    buildings.push({
      id: stableId(actor),
      kind,
      class: cls,
      min: [meters(box.min[0]), meters(box.min[1]), meters(box.min[2])],
      max: [meters(box.max[0]), meters(box.max[1]), meters(box.max[2])],
      parts: box.parts,
    });
  }
  buildings.sort((a, b) => a.min[0] - b.min[0] || a.min[1] - b.min[1] || a.id.localeCompare(b.id));
  return { buildings, partsWithoutExtent };
}

export function buildBuildingsFile(world: string, gameBuild: string, buildings: Building[]): BuildingsFile {
  return BuildingsFile.parse({
    schemaVersion: 1,
    world,
    gameBuild,
    units: "meters",
    shape: "axis-aligned bounding box",
    count: buildings.length,
    buildings,
  });
}

/** Footprints as GeoJSON. Coordinates are world X and Y in meters (not longitude and latitude). */
export function buildingsToGeoJson(world: string, gameBuild: string, buildings: readonly Building[]) {
  return {
    type: "FeatureCollection" as const,
    name: `${world}-buildings`,
    coordinateSystem: "world meters (X, Y); not geographic",
    gameBuild,
    features: buildings.map((b) => ({
      type: "Feature" as const,
      id: b.id,
      properties: { kind: b.kind, class: b.class, minZ: b.min[2], maxZ: b.max[2], baseZ: b.min[2], height: Math.round((b.max[2] - b.min[2]) * 100) / 100 },
      geometry: {
        type: "Polygon" as const,
        coordinates: [[[b.min[0], b.min[1]], [b.max[0], b.min[1]], [b.max[0], b.max[1]], [b.min[0], b.max[1]], [b.min[0], b.min[1]]]],
      },
    })),
  };
}
