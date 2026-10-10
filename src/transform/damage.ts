import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GeneratedFile } from "../generated.js";
import {
  DamageFile,
  type AmmoTypeEffectiveness,
  type DamageRule,
  type HitLocationMultipliers,
  type VehicleSeatProtection,
} from "../schema.gameplay.js";
import type { RawExport } from "./items.js";

type Props = Record<string, any>; // decoded game properties: shapes are checked field by field below

const tagName = (v: unknown): string | undefined => {
  const name = (v as { TagName?: unknown } | undefined)?.TagName;
  return typeof name === "string" && name !== "None" ? name : undefined;
};
/** A list of tags. The game writes some as plain strings and some as `{ TagName }` structs; both are read. */
const tags = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((t) => (typeof t === "string" ? t : tagName(t))).filter((t): t is string => t !== undefined && t !== "None") : [];
const strip = (value: string, prefix: string): string => (value.startsWith(prefix) ? value.slice(prefix.length) : value);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const DAMAGE = "Meta.Damage.";

/** The rows of every data table export, with the row struct's class name. */
function* tableRows(exports: RawExport[]): Generator<{ struct: string; key: string; row: Props }> {
  for (const exp of exports) {
    if (exp.Type !== "DataTable" || !exp.Rows) continue;
    const struct = String(((exp.Properties ?? {}) as Props).RowStruct?.ObjectName ?? "");
    for (const [key, row] of Object.entries(exp.Rows)) yield { struct, key, row: row as Props };
  }
}

/** True for a rule entry the game pads its tables with: no operation and no custom code. */
const isPadding = (om: Props | undefined): boolean => String(om?.Operation ?? "None").endsWith("None") && om?.bUseCustomOperation !== true;

/**
 * Parses the damage rule tables (`WDDamageableEntityTableRow`): one row per entity, each with a list of
 * modification entries. Padding entries, which change nothing, are dropped; everything else is kept in order.
 */
export function parseDamageRules(exports: RawExport[]): DamageRule[] {
  const rules: DamageRule[] = [];
  for (const { struct, key, row } of tableRows(exports)) {
    if (!struct.includes("WDDamageableEntityTableRow")) continue;
    for (const entry of (row.DamageModificationEntries ?? []) as Props[]) {
      const om = entry.OutModification as Props | undefined;
      const amount = num(om?.Amount);
      if (!om || isPadding(om) || amount === undefined) continue;
      const alignment = String(entry.AlignmentRequired ?? "None").replace("EWDDamageAlignment::", "");
      const category = tagName(om.PriorityCategory);
      const custom = om.bUseCustomOperation === true ? String(om.CustomOperationClass?.ObjectName ?? "").replace(/^[A-Za-z]+'(.*)'$/, "$1") : "";
      rules.push({
        entity: strip(key, DAMAGE),
        source: tags(entry.SourceRequirements).map((t) => strip(t, DAMAGE)),
        target: tags(entry.TargetRequirements).map((t) => strip(t, DAMAGE)),
        instigator: tags(entry.InstigatorRequirements).map((t) => strip(t, DAMAGE)),
        hitLocations: tags(entry.PossibleHitLocations).map((t) => strip(t, `${DAMAGE}HitLocation.`)),
        ...(alignment !== "None" ? { alignment } : {}),
        category: category ? strip(category, `${DAMAGE}Category.`) : "None",
        operation: String(om.Operation).replace("EWDDamageModificationOperation::", ""),
        amount,
        ...(custom ? { custom } : {}),
      });
    }
  }
  return rules;
}

/** Key and number pairs of a `{ Key: { TagName }, Value }` list. */
const tagValues = (v: unknown, keyPrefix: string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const item of Array.isArray(v) ? (v as Props[]) : []) {
    const key = tagName(item.Key);
    const value = num(item.Value);
    if (key && value !== undefined) out[strip(key, keyPrefix)] = value;
  }
  return out;
};

/**
 * Parses the body-part multiplier tables (`WDBoneDamageModifierData`): one row per weapon class, with a multiplier
 * for each hit location.
 */
export function parseHitLocationMultipliers(exports: RawExport[]): HitLocationMultipliers[] {
  const out: HitLocationMultipliers[] = [];
  for (const { struct, key, row } of tableRows(exports)) {
    if (!struct.includes("WDBoneDamageModifierData")) continue;
    out.push({ weaponClass: strip(key, DAMAGE), multipliers: tagValues(row.HitLocations, `${DAMAGE}HitLocation.Infantry.`) });
  }
  return out;
}

/** Finds the one list property of a row whose elements pass `test`. Blueprint struct fields have scrambled names, so the shape identifies them. */
const listProperty = (row: Props, test: (item: Props) => boolean): Props[] =>
  (Object.values(row).find((v) => Array.isArray(v) && v.length > 0 && v.every((i) => typeof i === "object" && i !== null && test(i as Props))) as Props[] | undefined) ?? [];

/** Parses the ammo-type penetration tables (`WDAmmoTypeEffectivenessData`). */
export function parseAmmoTypes(exports: RawExport[]): AmmoTypeEffectiveness[] {
  const out: AmmoTypeEffectiveness[] = [];
  for (const { struct, key, row } of tableRows(exports)) {
    if (!struct.includes("WDAmmoTypeEffectivenessData")) continue;
    const modifier = num(row.Modifier);
    if (modifier === undefined) continue;
    const byArms = listProperty(row, (i) => "Key" in i && "Value" in i);
    out.push({ ammoType: strip(key, `${DAMAGE}AmmoModifier.`), modifier, byArmsClass: tagValues(byArms, `${DAMAGE}Arms.`) });
  }
  return out;
}

/** Parses the occupant protection tables (`WDVehicleSeatDamageReductionData`): one row per vehicle variant. */
export function parseVehicleSeats(exports: RawExport[]): VehicleSeatProtection[] {
  const out: VehicleSeatProtection[] = [];
  for (const { struct, key, row } of tableRows(exports)) {
    if (!struct.includes("WDVehicleSeatDamageReductionData")) continue;
    const rules = listProperty(row, (i) => "DamageSources" in i && "VehicleSeats" in i).flatMap((entry) => {
      const values = Object.values(tagValues(entry.VehicleSeats, ""));
      return values.length ? [{ damageSources: tags(entry.DamageSources).map((t) => strip(t, `${DAMAGE}Arms.`)), reduction: values[0]! }] : [];
    });
    out.push({ vehicle: key, rules });
  }
  return out;
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** The tables the damage model lives in: the global rule tables, the per-vehicle ones, and the infantry helper tables. */
const isDamageTable = (f: string): boolean => /[\\/]DT_(GlobalDamage_|InfantryData_)[^\\/]*\.json$/.test(f);

export interface DamageBuild {
  files: GeneratedFile[];
  notes: string[];
}

/** Builds `data/damage.json` from the raw cache, without touching the disk. */
export function buildDamageData(rawDir: string, gameBuild: string): DamageBuild {
  const itemsDir = join(rawDir, "items");
  const rules: DamageRule[] = [];
  const hitLocationMultipliers: HitLocationMultipliers[] = [];
  const ammoTypes: AmmoTypeEffectiveness[] = [];
  const vehicleSeats: VehicleSeatProtection[] = [];
  for (const file of walk(itemsDir)) {
    if (!isDamageTable(file)) continue;
    const exports = JSON.parse(readFileSync(file, "utf8")) as RawExport[];
    rules.push(...parseDamageRules(exports));
    hitLocationMultipliers.push(...parseHitLocationMultipliers(exports));
    ammoTypes.push(...parseAmmoTypes(exports));
    vehicleSeats.push(...parseVehicleSeats(exports));
  }
  const entities = new Set(rules.map((r) => r.entity));
  const content = JSON.stringify(DamageFile.parse({ schemaVersion: 1, gameBuild, rules, hitLocationMultipliers, ammoTypes, vehicleSeats }), null, 2) + "\n";
  return {
    files: [{ path: "data/damage.json", content }],
    notes: [`damage: ${rules.length} rules for ${entities.size} entities, ${hitLocationMultipliers.length} weapon classes, ${ammoTypes.length} ammo types, ${vehicleSeats.length} vehicles with seat protection`],
  };
}
