import { PUBLISHED } from "./derived/schemas.js";

/** One published file that is a list of records, and how to tell records apart and name them. */
export interface RecordSet {
  /** Schema name from `PUBLISHED`. */
  schema: string;
  /** Path of the file, or a pattern with one capture for per-world files. */
  path: string | RegExp;
  /** The array of records inside the parsed file. */
  records: (json: Record<string, unknown>) => unknown[];
  /** Identity of a record: two records with the same key are the same thing in two builds. */
  key: (record: any) => string; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** How to show a record to a reader. Defaults to the key. */
  label?: (record: any) => string; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const list = (name: string) => (json: Record<string, unknown>) => (json[name] as unknown[]) ?? [];
const join = (...parts: unknown[]) => parts.map((p) => (Array.isArray(p) ? p.join("+") : String(p ?? ""))).join("|");

/**
 * Every record-based file and how its records are keyed. A game patch is read through these: records added, removed
 * and changed field by field. Files that are not lists of records (map metadata, terrain) are in `NOT_RECORDS`.
 */
export const RECORD_SETS: readonly RecordSet[] = [
  { schema: "items", path: "data/items.json", records: list("items"), key: (r) => r.id, label: (r) => `${r.name} (${r.id})` },
  { schema: "weapons", path: "data/weapons.json", records: list("weapons"), key: (r) => r.id },
  { schema: "ammo", path: "data/ammo.json", records: list("projectiles"), key: (r) => r.asset, label: (r) => `${r.id} (${r.asset.split("/").pop()})` },
  { schema: "attachments", path: "data/attachments.json", records: list("attachments"), key: (r) => r.id },
  { schema: "vehicles", path: "data/vehicles.json", records: list("vehicles"), key: (r) => r.id },
  {
    schema: "vehicle-configs",
    path: "data/vehicle-configs.json",
    records: (json) => [...((json.configs as object[]) ?? []).map((c) => ({ kind: "config", ...c })), ...((json.assets as object[]) ?? []).map((a) => ({ kind: "asset", ...a }))],
    key: (r) => `${r.kind}|${r.package}`,
    label: (r) => `${r.kind} ${r.package}`,
  },
  { schema: "equipment", path: "data/equipment.json", records: list("armor"), key: (r) => r.id },
  { schema: "buildables", path: "data/buildables.json", records: list("buildables"), key: (r) => r.id, label: (r) => `${r.name ?? r.id} (${r.id})` },
  { schema: "loot", path: "data/loot.json", records: list("tables"), key: (r) => r.id },
  { schema: "tags", path: "data/tags.json", records: list("tags"), key: (r) => `${r.tag}|${r.source}`, label: (r) => `${r.tag} = ${r.text}` },
  { schema: "cosmetics", path: "data/cosmetics.json", records: list("cosmetics"), key: (r) => `${r.id}|${r.source}` },
  { schema: "movement", path: "data/movement.json", records: (json) => [Object.fromEntries(Object.entries(json).filter(([k]) => k !== "schemaVersion" && k !== "gameBuild"))], key: () => "movement", label: () => "movement" },
  { schema: "skills", path: "data/skills.json", records: list("skills"), key: (r) => r.id, label: (r) => `${r.name ?? r.id} (${r.id})` },
  {
    schema: "challenge-rewards",
    path: "data/challenge-rewards.json",
    records: (json) => [...((json.events as object[]) ?? []).map((e) => ({ kind: "event", ...e })), ...((json.rewards as object[]) ?? []).map((r) => ({ kind: "reward", ...r })), ...((json.curves as object[]) ?? []).map((c) => ({ kind: "curve", ...c }))],
    key: (r) => `${r.kind}|${r.id}`,
    label: (r) => `${r.kind} ${r.id}`,
  },
  {
    schema: "meta",
    path: "data/meta.json",
    records: (json) => [
      ...((json.currencies as object[]) ?? []).map((r) => ({ kind: "currency", ...r })),
      ...((json.goldMarket as object[]) ?? []).map((r) => ({ kind: "gold-market", ...r })),
      ...((json.passiveMissions as object[]) ?? []).map((r) => ({ kind: "passive-mission", ...r })),
      ...((json.achievements as object[]) ?? []).map((r) => ({ kind: "achievement", ...r })),
    ],
    key: (r) => `${r.kind}|${r.id}`,
    label: (r) => `${r.kind} ${r.id}`,
  },
  { schema: "roles", path: "data/roles.json", records: list("roles"), key: (r) => r.id },
  { schema: "rewards", path: "data/rewards.json", records: list("rewards"), key: (r) => `${r.action}|${r.context}` },
  {
    schema: "damage",
    path: "data/damage.json",
    records: list("rules"),
    key: (r) => join(r.entity, r.category, r.source, r.target, r.instigator, r.hitLocations, r.alignment ?? ""),
    label: (r) => `${r.entity}: ${[...r.source, ...(r.target.length ? ["vs", ...r.target] : []), ...r.hitLocations].join(" ")} [${r.category}]`,
  },
  { schema: "buildings", path: /^data\/maps\/([^/]+)\/buildings\.json$/, records: list("buildings"), key: (r) => r.id },
  { schema: "objects", path: /^data\/maps\/([^/]+)\/objects\.json$/, records: list("objects"), key: (r) => r.id, label: (r) => `${r.kind} ${r.id}` },
  {
    schema: "objectives",
    path: /^data\/maps\/([^/]+)\/objectives\.json$/,
    records: list("configs"),
    key: (r) => r.config,
  },
];

/** Published file types that are one record, not a list of them: they are compared as a whole. */
export const NOT_RECORDS: readonly string[] = ["map", "terrain"];

/** One difference inside a record: a dotted path with the value before and after. */
export interface FieldChange {
  path: string;
  before: unknown;
  after: unknown;
}

export interface RecordChange {
  key: string;
  label: string;
  fields: FieldChange[];
}

export interface RecordDiff {
  added: Array<{ key: string; label: string }>;
  removed: Array<{ key: string; label: string }>;
  changed: RecordChange[];
}

/** Records by key. Records that share a key (the game repeats some rules) get an occurrence number so none is lost. */
function keyed(records: readonly unknown[], set: Pick<RecordSet, "key" | "label">): Map<string, { record: unknown; label: string }> {
  const seen = new Map<string, number>();
  const out = new Map<string, { record: unknown; label: string }>();
  for (const record of records) {
    const base = set.key(record);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const label = (set.label ?? set.key)(record);
    out.set(n === 1 ? base : `${base}#${n}`, { record, label: n === 1 ? label : `${label} #${n}` });
  }
  return out;
}

/** Flattens nested objects to dotted paths. Arrays are leaves, compared whole. */
export function flatten(value: unknown, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) for (const [p, x] of flatten(v, prefix ? `${prefix}.${k}` : k)) out.set(p, x);
  } else {
    out.set(prefix, value);
  }
  return out;
}

/** Compares two lists of records by key: which were added or removed, and which fields changed in the others. */
export function diffRecords(before: readonly unknown[], after: readonly unknown[], set: Pick<RecordSet, "key" | "label">): RecordDiff {
  const prev = keyed(before, set);
  const next = keyed(after, set);
  const diff: RecordDiff = { added: [], removed: [], changed: [] };
  for (const [key, { record, label }] of next) {
    const old = prev.get(key);
    if (!old) {
      diff.added.push({ key, label });
      continue;
    }
    const a = flatten(old.record);
    const b = flatten(record);
    const fields: FieldChange[] = [];
    for (const path of new Set([...a.keys(), ...b.keys()])) {
      if (JSON.stringify(a.get(path)) !== JSON.stringify(b.get(path))) fields.push({ path, before: a.get(path), after: b.get(path) });
    }
    if (fields.length) diff.changed.push({ key, label, fields });
  }
  for (const [key, { label }] of prev) if (!next.has(key)) diff.removed.push({ key, label });
  return diff;
}

export const isEmptyRecordDiff = (d: RecordDiff): boolean => d.added.length + d.removed.length + d.changed.length === 0;

const show = (value: unknown): string => {
  const text = value === undefined ? "(absent)" : JSON.stringify(value);
  return `\`${text.length > 120 ? `${text.slice(0, 117)}...` : text}\``;
};

/** Renders one file's diff as Markdown. Long lists are cut at `limit` lines per section, with the number left out. */
export function formatRecordDiff(title: string, d: RecordDiff, limit = 60): string[] {
  if (isEmptyRecordDiff(d)) return [];
  const lines = [`### ${title}`, "", `${d.added.length} added, ${d.removed.length} removed, ${d.changed.length} changed.`, ""];
  const section = (name: string, rows: string[]) => {
    if (!rows.length) return;
    lines.push(`**${name}**`, "", ...rows.slice(0, limit).map((r) => `- ${r}`));
    if (rows.length > limit) lines.push(`- ... and ${rows.length - limit} more`);
    lines.push("");
  };
  section("Added", d.added.map((r) => r.label));
  section("Removed", d.removed.map((r) => r.label));
  section(
    "Changed",
    d.changed.flatMap((c) => c.fields.map((f) => `${c.label}: ${f.path} ${show(f.before)} -> ${show(f.after)}`)),
  );
  return lines;
}

/** The record set a data file belongs to, with the world it is for when the path is per world. */
export function recordSetFor(path: string): { set: RecordSet; world?: string } | undefined {
  for (const set of RECORD_SETS) {
    if (typeof set.path === "string") {
      if (set.path === path) return { set };
    } else {
      const m = set.path.exec(path);
      if (m) return { set, world: m[1] };
    }
  }
  return undefined;
}

/** Schema names that have neither a record set nor an entry in `NOT_RECORDS`. A new dataset must declare how it is diffed. */
export const undeclaredSchemas = (): string[] => PUBLISHED.map((p) => p.name).filter((n) => !RECORD_SETS.some((s) => s.schema === n) && !NOT_RECORDS.includes(n));

/**
 * Compares the committed and current contents of one file and renders the result. `before` is undefined when the file
 * is new. File-level (non-record) schemas are compared as one record.
 */
export function diffFile(path: string, before: unknown, after: unknown): { lines: string[]; empty: boolean } {
  const match = recordSetFor(path);
  const title = match?.world ? `${path}` : path;
  if (!match) {
    const diff = diffRecords(before === undefined ? [] : [before], after === undefined ? [] : [after], { key: () => path, label: () => path });
    return { lines: formatRecordDiff(title, diff), empty: isEmptyRecordDiff(diff) };
  }
  const get = (json: unknown) => (json === undefined ? [] : match.set.records(json as Record<string, unknown>));
  const diff = diffRecords(get(before), get(after), match.set);
  return { lines: formatRecordDiff(title, diff), empty: isEmptyRecordDiff(diff) };
}
