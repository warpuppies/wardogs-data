import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GeneratedFile } from "../generated.js";
import { ChallengeRewardsFile, RewardsFile, RolesFile, SkillsFile, type Reward, type Role, type Skill, type SkillEffect, type SkillLayout, type SkillTree } from "../schema.gameplay.js";
import type { RawExport } from "./items.js";
import { buildChallengeRewards } from "./challengeRewards.js";
import { PackageIndex } from "./packages.js";

type Props = Record<string, any>; // decoded game properties: shapes are checked field by field below

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const tagName = (v: unknown): string | undefined => {
  const name = (v as { TagName?: unknown } | undefined)?.TagName;
  return typeof name === "string" && name !== "None" ? name : undefined;
};
const strip = (value: string, prefix: string): string => (value.startsWith(prefix) ? value.slice(prefix.length) : value);
const text = (v: unknown): string | undefined => {
  const t = v as { LocalizedString?: string | null; SourceString?: string | null; CultureInvariantString?: string | null } | undefined;
  return (t?.LocalizedString ?? t?.SourceString ?? t?.CultureInvariantString)?.replace(/\r\n?/g, "\n").trim() || undefined;
};
const objectPath = (v: unknown): string | undefined => {
  const path = (v as { ObjectPath?: unknown } | undefined)?.ObjectPath;
  return typeof path === "string" && path !== "" ? path : undefined;
};
const enumName = (v: unknown): string => String(v ?? "").replace(/^E[A-Za-z]+Type::/, "").replace(/^E[A-Za-z]+::/, "");
/** `BlueprintGeneratedClass'GE_Name_C'` becomes `GE_Name`. */
const effectName = (v: unknown): string | undefined => {
  const raw = (v as { ObjectName?: unknown } | undefined)?.ObjectName;
  const match = typeof raw === "string" ? /'(.+?)(?:_C)?'$/.exec(raw) : null;
  return match?.[1];
};

function* tableRows(exports: RawExport[]): Generator<{ struct: string; key: string; row: Props }> {
  for (const exp of exports) {
    if (exp.Type !== "DataTable" || !exp.Rows) continue;
    const struct = String(((exp.Properties ?? {}) as Props).RowStruct?.ObjectName ?? "");
    for (const [key, row] of Object.entries(exp.Rows)) yield { struct, key, row: row as Props };
  }
}

/** The points of one row of a curve table, as `[level, value]` pairs. */
function curveLevels(table: RawExport[] | undefined, row: string): Array<{ level: number; value: number }> | undefined {
  const exp = table?.find((e) => e.Type === "CurveTable");
  const keys = ((exp?.Rows as Record<string, Props> | undefined)?.[row]?.Keys ?? []) as Props[];
  const points = keys.flatMap((k) => (num(k.Time) !== undefined && num(k.Value) !== undefined ? [{ level: k.Time as number, value: k.Value as number }] : []));
  return points.length ? points : undefined;
}

/** Display names and descriptions from the skill tree's UI table (`WDMetaTreeNodeData_UI`), by skill tag. */
export function parseSkillNodes(exports: RawExport[]): Map<string, { name?: string; description?: string }> {
  const out = new Map<string, { name?: string; description?: string }>();
  for (const { struct, key, row } of tableRows(exports)) {
    if (!struct.includes("WDMetaTreeNodeData_UI")) continue;
    const name = text(row.FriendlyName);
    const description = text(row.Description);
    out.set(key, { ...(name ? { name } : {}), ...(description ? { description } : {}) });
  }
  return out;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Parses the skill tree presets (`WDUIMetaTreePresetDataAsset`): the grid of each role and the row, column and canvas
 * position of every skill placed on it, by skill tag.
 */
export function parseSkillLayout(exports: RawExport[]): { layout: Map<string, SkillLayout>; trees: SkillTree[] } {
  const layout = new Map<string, SkillLayout>();
  const trees: SkillTree[] = [];
  for (const exp of exports) {
    if (exp.Type !== "WDUIMetaTreePresetDataAsset") continue;
    for (const preset of (((exp.Properties ?? {}) as Props).TreePresets ?? []) as Props[]) {
      const role = strip(tagName(preset.Key) ?? "", "Meta.Role.");
      const grid = (preset.Value?.GridPreset ?? {}) as Props;
      const rows = num(grid.Rows);
      const columns = num(grid.Columns);
      if (role && rows && columns) trees.push({ role, rows, columns, shape: enumName(grid.GridType) });
      for (const node of (preset.Value?.NodePresets ?? []) as Props[]) {
        const tag = tagName(node.EntryID);
        const row = num(node.GridPoint?.Row);
        const column = num(node.GridPoint?.Column);
        const x = num(node.CanvasPosition?.X);
        const y = num(node.CanvasPosition?.Y);
        if (tag && row !== undefined && column !== undefined && x !== undefined && y !== undefined) layout.set(tag, { row, column, x: round3(x), y: round3(y) });
      }
    }
  }
  return { layout, trees: trees.sort((a, b) => a.role.localeCompare(b.role)) };
}

/** Skills the tree's UI table names but no effects table covers: text and place only, with no effects. */
export function nodeOnlySkills(nodes: ReadonlyMap<string, { name?: string; description?: string }>, known: ReadonlySet<string>): Skill[] {
  const out: Skill[] = [];
  for (const [key, node] of nodes) {
    const id = strip(key, "Meta.Role.");
    if (known.has(id) || id === key) continue;
    out.push({ id, role: id.split(".")[0] ?? id, ...(node.name ? { name: node.name } : {}), ...(node.description ? { description: node.description } : {}), effects: [] });
  }
  return out;
}

/**
 * Parses a role's skill effects table (`WDMetaSkillEffectsTaggedTableRow`). The value of a leveled effect comes from a
 * curve row, which is read from the curve table the magnitude points at.
 */
export function parseSkills(exports: RawExport[], nodes: ReadonlyMap<string, { name?: string; description?: string }>, index: Pick<PackageIndex, "load">): Skill[] {
  const skills: Skill[] = [];
  for (const { struct, key, row } of tableRows(exports)) {
    if (!struct.includes("WDMetaSkillEffectsTaggedTableRow")) continue;
    const id = strip(key, "Meta.Role.");
    const role = id.split(".")[0] ?? id;
    const effects: SkillEffect[] = [];
    for (const trigger of (row.SkillEffects ?? []) as Props[]) {
      const triggerName = strip(tagName(trigger.Key) ?? "", "Meta.Skill.");
      for (const entry of (trigger.Value?.SkillEffects ?? []) as Props[]) {
        const effect = effectName(entry.Effect);
        if (!effect) continue;
        const leveled = ((entry.CustomMagnitudes ?? []) as Props[]).flatMap((m) => {
          const rowName = m.Value?.Curve?.RowName;
          const attribute = tagName(m.Key);
          if (typeof rowName !== "string" || rowName === "None") return [];
          const levels = curveLevels(index.load(objectPath(m.Value.Curve.CurveTable)), rowName);
          return [{ attribute: attribute ? strip(attribute, "Attribute.Gameplay.") : undefined, curve: rowName, levels }];
        });
        if (leveled.length === 0) effects.push({ trigger: triggerName, effect });
        for (const l of leveled) {
          effects.push({ trigger: triggerName, effect, ...(l.attribute ? { attribute: l.attribute } : {}), curve: l.curve, ...(l.levels ? { levels: l.levels } : {}) });
        }
      }
    }
    const node = nodes.get(key);
    skills.push({ id, role, ...(node?.name ? { name: node.name } : {}), ...(node?.description ? { description: node.description } : {}), effects });
  }
  return skills;
}

/**
 * Parses a cash reward table (`WDCustomRewardTableRow`): one row per case with a base amount and named modifiers. The
 * action is the table's name, passed by the caller.
 */
export function parseRewards(action: string, exports: RawExport[]): Reward[] {
  const out: Reward[] = [];
  for (const { struct, key, row } of tableRows(exports)) {
    if (!struct.includes("WDCustomRewardTableRow")) continue;
    const base = num(row.base);
    if (base === undefined) continue;
    const modifiers: Record<string, number> = {};
    for (const [name, value] of Object.entries(row)) {
      if (name === "base" || typeof value !== "number" || !Number.isFinite(value)) continue;
      modifiers[name] = value;
    }
    const resource = tagName(row.ResourceTag);
    const description = text(row.Description);
    out.push({
      action,
      context: strip(key, "Meta.Progression.Context."),
      ...(description ? { description } : {}),
      resource: resource ? strip(resource, "Attribute.Meta.Currency.") : "Unknown",
      base,
      modifiers,
    });
  }
  return out;
}

/**
 * Parses the role mastery table (`WDMetaMasteryDefinitionTableRow`): one row per role with the XP of every level. A
 * level that grants rewards is reported through `onRewards` because rewards are not published.
 */
export function parseRoles(exports: RawExport[], onRewards: (role: string, level: number) => void = () => undefined): Role[] {
  const roles: Role[] = [];
  for (const { struct, key, row } of tableRows(exports)) {
    if (!struct.includes("WDMetaMasteryDefinitionTableRow")) continue;
    const resource = tagName(row.ResourceTag);
    if (!resource) continue;
    const id = strip(key, "Meta.Role.");
    const levels = ((row.LevelDefinitions ?? []) as Props[]).flatMap((l) => {
      const level = num(l.Level);
      const xp = num(l.XP);
      if (level === undefined || xp === undefined) return [];
      if (Array.isArray(l.Rewards) && l.Rewards.length) onRewards(id, level);
      return [{ level, xp }];
    });
    roles.push({ id, xpResource: strip(resource, "Attribute.Meta."), levels: levels.sort((a, b) => a.level - b.level) });
  }
  return roles.sort((a, b) => a.id.localeCompare(b.id));
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

const read = (file: string): RawExport[] => JSON.parse(readFileSync(file, "utf8")) as RawExport[];
const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";

export interface ProgressionBuild {
  files: GeneratedFile[];
  notes: string[];
}

/** Builds `data/skills.json`, `data/rewards.json`, `data/roles.json` and `data/challenge-rewards.json` from the raw cache, without touching the disk. */
export function buildProgressionData(rawDir: string, gameBuild: string): ProgressionBuild {
  const itemsDir = join(rawDir, "items");
  const index = new PackageIndex([itemsDir, join(rawDir, "gameplay")]);
  const all = [...walk(itemsDir)];

  const nodes = new Map<string, { name?: string; description?: string }>();
  for (const file of all.filter((f) => /[\\/]DT_CharacterSkillNodes_Data\.json$/.test(f))) for (const [k, v] of parseSkillNodes(read(file))) nodes.set(k, v);
  const withEffects = all.filter((f) => /[\\/]DT_[A-Za-z]+Skills\.json$/.test(f)).flatMap((f) => parseSkills(read(f), nodes, index));
  const { layout, trees } = [...walk(join(rawDir, "gameplay"))]
    .filter((f) => /[\\/]DA_UI_RoleSkillTree_NodePresetData\.json$/.test(f))
    .map((f) => parseSkillLayout(read(f)))[0] ?? { layout: new Map<string, SkillLayout>(), trees: [] };
  const skills = [...withEffects, ...nodeOnlySkills(nodes, new Set(withEffects.map((k) => k.id)))]
    .map((k) => (layout.has(`Meta.Role.${k.id}`) ? { ...k, layout: layout.get(`Meta.Role.${k.id}`)! } : k))
    .sort((a, b) => a.id.localeCompare(b.id));

  const rewards = all
    .filter((f) => /[\\/]DT_Reward_Cash_[^\\/]*\.json$/.test(f))
    .flatMap((f) => parseRewards(/DT_Reward_Cash_([^\\/]*)\.json$/.exec(f)![1]!, read(f)));
  rewards.sort((a, b) => a.action.localeCompare(b.action)); // stable: keeps the game's order inside an action

  const rewardLevels: string[] = [];
  const roles = all
    .filter((f) => /[\\/]DT_RoleMasteryDefinitions\.json$/.test(f))
    .flatMap((f) => parseRoles(read(f), (role, level) => rewardLevels.push(`${role} ${level}`)));

  const challenge = buildChallengeRewards(rawDir, index);

  const header = { schemaVersion: 1 as const, gameBuild };
  const leveled = skills.filter((s) => s.effects.some((e) => e.levels)).length;
  return {
    files: [
      { path: "data/skills.json", content: json(SkillsFile.parse({ ...header, trees, skills })) },
      { path: "data/rewards.json", content: json(RewardsFile.parse({ ...header, rewards })) },
      { path: "data/roles.json", content: json(RolesFile.parse({ ...header, roles })) },
      { path: "data/challenge-rewards.json", content: json(ChallengeRewardsFile.parse({ ...header, events: challenge.events, rewards: challenge.rewards, curves: challenge.curves })) },
    ],
    notes: [
      `skills: ${skills.length} (${skills.filter((s) => s.name).length} named, ${leveled} with level curves, ${skills.filter((s) => !s.effects.length).length} without effect data, ${skills.filter((s) => s.layout).length} placed in a tree)`,
      `rewards: ${rewards.length} cases for ${new Set(rewards.map((r) => r.action)).size} actions`,
      `challenge rewards: ${challenge.events.length} event definitions, ${challenge.rewards.length} rewards paying ${challenge.rewards.reduce((n, r) => n + r.resources.length, 0)} resources, ${challenge.curves.length} curves`,
      `roles: ${roles.length} with ${roles[0]?.levels.length ?? 0} levels`,
      ...(rewardLevels.length ? [`note: ${rewardLevels.length} role levels grant rewards, which are not published (${rewardLevels.slice(0, 3).join(", ")}...)`] : []),
    ],
  };
}
