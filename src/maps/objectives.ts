import type { GeneratedFile } from "../generated.js";
import { ObjectivesFile, type ObjectiveZone } from "../schema.js";
import type { RawExport } from "../transform/items.js";
import type { WorldDef } from "./worlds.js";

type Props = Record<string, any>; // decoded game properties: shapes are checked field by field below

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const CM = 100;
const m = (v: unknown): number => Math.round(((num(v) ?? 0) / CM) * 1e4) / 1e4;
const stripShape = (v: unknown): string | undefined => (typeof v === "string" ? v.replace("EWDZoneShape::", "") : undefined);

/**
 * Which world a control zone config belongs to, by the map name in the config's asset name. Declared here, not
 * inferred: a config for the test gym or a new map is reported as unplaced and reviewed.
 */
export const CONTROL_ZONE_WORLDS: Readonly<Record<string, string>> = {
  Bakurani: "kavkazi",
  Europe: "europe",
  NorthAmerica: "north-america",
};

/** The world id and mode of a config asset name, such as `DA_ControlZoneConfig_SniperShowdown_Bakurani`. */
export function classifyConfig(name: string): { world: string; mode: string } | null {
  const match = /^DA_ControlZone_?Config_(.+)$/.exec(name);
  if (!match) return null;
  const parts = match[1]!.split("_");
  const mapName = parts.at(-1)!;
  const world = CONTROL_ZONE_WORLDS[mapName];
  if (!world) return null;
  const mode = parts.slice(0, -1).join("_");
  return { world, mode: mode || "Standard" };
}

/** Reads one zone's center, size and shape. The location is required: a zone without one has no position to publish. */
export function parseZone(controlZone: Props | undefined, hotZone: Props | undefined): ObjectiveZone | null {
  const loc = controlZone?.ControlZoneActorLocation as Props | undefined;
  const ext = controlZone?.ZoneScaledExtents as Props | undefined;
  if (!loc || !ext) return null;
  const hot = hotZone?.ZoneScaledExtents as Props | undefined;
  const shape = stripShape(controlZone?.ZoneShape);
  const hotShape = stripShape(hotZone?.ZoneShape);
  return {
    center: [m(loc.X), m(loc.Y), m(loc.Z)],
    extents: [m(ext.X), m(ext.Y), m(ext.Z)],
    ...(shape ? { shape } : {}),
    hotZone: { extents: [m(hot?.X), m(hot?.Y), m(hot?.Z)], ...(hotShape ? { shape: hotShape } : {}) },
  };
}

/** Parses a control zone configuration asset (`WDControlZoneConfigDataAsset`). */
export function parseControlZoneConfig(name: string, exp: RawExport): ObjectivesFile["configs"][number] | null {
  const kind = classifyConfig(name);
  const p = (exp.Properties ?? {}) as Props;
  const zone = parseZone(p.ZoneData?.ControlZoneData, p.ZoneData?.HotZoneData);
  if (!kind || !zone) return null;
  const alternatives = ((p.AlternatorZoneData ?? []) as Props[]).flatMap((a) => {
    const id = a.AlternatorTag?.TagName;
    const alt = parseZone(a.ControlZoneData, a.HotZoneData);
    return typeof id === "string" && alt ? [{ id, weight: num(a.AlternatorSelectionWeight) ?? 1, zone: alt }] : [];
  });
  const mv = (p.HotZoneMovementData ?? {}) as Props;
  const move = {
    firstMoveDelay: num(mv.FirstMoveDelay),
    moveDelay: num(mv.MoveDelay),
    innerRadiusFraction: num(mv.HotZoneInnerRadiusPercentage),
    defaultSpeed: num(mv.DefaultSpeed),
    dynamicSpeeds: typeof mv.bUseDynamicHotzoneSpeeds === "boolean" ? mv.bUseDynamicHotzoneSpeeds : undefined,
    speeds: Array.isArray(mv.HotzoneSpeeds) ? (mv.HotzoneSpeeds as unknown[]).filter((s): s is number => typeof s === "number") : [],
    minMoveDistance: num(mv.MinHotZoneMoveDistance) === undefined ? undefined : m(mv.MinHotZoneMoveDistance),
  };
  return {
    config: name,
    mode: kind.mode,
    zone,
    alternatives,
    hotZoneMovement: Object.fromEntries(Object.entries(move).filter(([, v]) => v !== undefined)) as ObjectivesFile["configs"][number]["hotZoneMovement"],
  };
}

export interface ConfigSource {
  name: string;
  export: RawExport;
}

/** Builds one `objectives.json` per world that has a control zone configuration. Unplaced configs are returned for the build notes. */
export function buildObjectives(sources: readonly ConfigSource[], worlds: readonly WorldDef[], gameBuild: string): { files: GeneratedFile[]; unplaced: string[] } {
  const byWorld = new Map<string, ObjectivesFile["configs"]>();
  const unplaced: string[] = [];
  for (const source of sources) {
    const kind = classifyConfig(source.name);
    const config = parseControlZoneConfig(source.name, source.export);
    if (!kind || !config) {
      unplaced.push(source.name);
      continue;
    }
    byWorld.set(kind.world, [...(byWorld.get(kind.world) ?? []), config]);
  }
  const files: GeneratedFile[] = [];
  for (const w of worlds) {
    const configs = byWorld.get(w.id);
    if (!configs) continue;
    configs.sort((a, b) => a.config.localeCompare(b.config));
    const file = ObjectivesFile.parse({ schemaVersion: 1, world: w.folder, gameBuild, units: "meters", configs });
    files.push({ path: `data/maps/${w.id}/objectives.json`, content: JSON.stringify(file, null, 2) + "\n" });
  }
  return { files, unplaced: unplaced.sort() };
}
