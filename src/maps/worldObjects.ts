import { createHash } from "node:crypto";
import type { GeneratedFile } from "../generated.js";
import { OBJECT_KIND_NAMES, WorldObjectsFile, type WorldObject } from "../schema.js";
import type { WorldDef } from "./worlds.js";

type Props = Record<string, any>; // decoded game properties: shapes are checked field by field below

type Kind = (typeof OBJECT_KIND_NAMES)[number];

/**
 * The actor classes that count as gameplay objects. Declared here, not inferred, so adding one is a reviewable change;
 * the extractor's class pattern is built from the same list.
 */
export const OBJECT_CLASSES: ReadonlyArray<{ kind: Kind; pattern: RegExp }> = [
  { kind: "equipment-vendor", pattern: /^B_EquipmentVendor_C$/ },
  { kind: "vehicle-vendor", pattern: /^B_VehicleVendor_C$/ },
  { kind: "garage-vendor", pattern: /^B_GarageVendor_C$/ },
  { kind: "safe-zone", pattern: /^B_SafeZone_C$/ },
  { kind: "safe-zone-camera", pattern: /^B_SafeZoneCam_C$/ },
  { kind: "spawn-manager", pattern: /^B_SpawnManager_C$/ },
  { kind: "spawn-volume", pattern: /^WDSpawnVolume$/ },
  { kind: "vehicle-deployment-board", pattern: /^B_VehicleDeploymentBoard_.*_C$/ },
  { kind: "fuel-refill", pattern: /^B_SpawnFuelItemRefill_C$/ },
];
// `PlayerStart` is not listed on purpose: each world's main level has one editor placeholder at the world origin, which is
// off the playable map. Teams spawn through the spawn managers and volumes above.

/** The pattern the extractor filters classes with: every declared class. */
export const OBJECT_CLASS_PATTERN = `^(?:${OBJECT_CLASSES.map((c) => c.pattern.source.replace(/^\^|\$$/g, "")).join("|")})$`;

const CM = 100;
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const m = (v: unknown): number => Math.round(((num(v) ?? 0) / CM) * 1e4) / 1e4;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** A raw actor line from the extractor. */
export interface ActorLine {
  cls: string;
  name: string;
  package: string;
  location?: Props | null;
  rotation?: Props | null;
  scale?: Props | null;
  props?: Props | null;
}

export const kindOf = (cls: string): Kind | undefined => OBJECT_CLASSES.find((c) => c.pattern.test(cls))?.kind;

/** Stable id from the actor's name and level, which do not change between game builds unless the actor is replaced. */
export const objectId = (line: Pick<ActorLine, "name" | "package">): string => createHash("sha256").update(`${line.package}|${line.name}`).digest("hex").slice(0, 12);

/** Converts one extractor line to a published object, or null when the class is not a declared gameplay class or it has no position. */
export function parseActor(line: ActorLine): WorldObject | null {
  const kind = kindOf(line.cls);
  const loc = line.location;
  if (!kind || !loc) return null;
  const p = (line.props ?? {}) as Props;
  const faction = typeof p.FactionTag?.TagName === "string" ? p.FactionTag.TagName.replace("Meta.Alignment.Faction.", "") : undefined;
  const yaw = num(line.rotation?.Yaw);
  const scale = line.scale && [num(line.scale.X), num(line.scale.Y), num(line.scale.Z)].every((v) => v !== undefined) ? ([line.scale.X, line.scale.Y, line.scale.Z] as [number, number, number]) : undefined;
  const tags = strings(p.TagsToApply);
  const allowed = strings(p.AllowedObjectsToSpawn);
  const disallowed = strings(p.DisallowedObjectsToSpawn);
  return {
    id: objectId(line),
    kind,
    class: line.cls,
    position: [m(loc.X), m(loc.Y), m(loc.Z)],
    ...(yaw ? { yaw: Math.round(yaw * 100) / 100 } : {}),
    ...(scale && !(scale[0] === 1 && scale[1] === 1 && scale[2] === 1) ? { scale: [Math.round(scale[0] * 1e4) / 1e4, Math.round(scale[1] * 1e4) / 1e4, Math.round(scale[2] * 1e4) / 1e4] as [number, number, number] } : {}),
    ...(faction && faction !== "None" ? { faction } : {}),
    ...(tags.length ? { tags } : {}),
    ...(allowed.length ? { allowedVehicles: allowed } : {}),
    ...(disallowed.length ? { disallowedVehicles: disallowed } : {}),
  };
}

/** Parses the extractor's JSON lines into published objects, sorted by kind then position. Unparsable and unplaced lines are skipped and counted. */
export function parseActorLines(text: string): { objects: WorldObject[]; skipped: number } {
  const objects: WorldObject[] = [];
  let skipped = 0;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let line: ActorLine;
    try {
      line = JSON.parse(raw) as ActorLine;
    } catch {
      skipped++;
      continue;
    }
    const object = parseActor(line);
    if (object) objects.push(object);
    else skipped++;
  }
  const order = new Map(OBJECT_KIND_NAMES.map((k, i) => [k, i]));
  objects.sort((a, b) => order.get(a.kind)! - order.get(b.kind)! || a.position[0] - b.position[0] || a.position[1] - b.position[1] || a.position[2] - b.position[2] || a.id.localeCompare(b.id));
  return { objects, skipped };
}

/** Builds `objects.json` for a world from the extractor's output text. */
export function buildWorldObjects(world: WorldDef, actorLines: string, gameBuild: string): { file: GeneratedFile; counts: Record<string, number>; skipped: number } {
  const { objects, skipped } = parseActorLines(actorLines);
  const file = WorldObjectsFile.parse({ schemaVersion: 1, world: world.folder, gameBuild, units: "meters", count: objects.length, objects });
  const counts: Record<string, number> = {};
  for (const o of objects) counts[o.kind] = (counts[o.kind] ?? 0) + 1;
  return { file: { path: `data/maps/${world.id}/objects.json`, content: JSON.stringify(file, null, 2) + "\n" }, counts, skipped };
}
