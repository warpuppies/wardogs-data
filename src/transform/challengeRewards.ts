import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ChallengeReward, RewardCondition, RewardEvent, RewardCurve, RewardInput, RewardResource, RewardVariable } from "../schema.gameplay.js";
import type { RawExport } from "./items.js";
import type { PackageIndex } from "./packages.js";

type Props = Record<string, any>; // decoded game properties: shapes are checked field by field below

const strip = (value: string, prefix: string): string => (value.startsWith(prefix) ? value.slice(prefix.length) : value);

const EXPRESSION_TYPES = { 1: ["any", "tags"], 2: ["all", "tags"], 3: ["none", "tags"], 4: ["any", "exprs"], 5: ["all", "exprs"], 6: ["none", "exprs"] } as const;

/**
 * Decodes a gameplay tag query (`TagDictionary` and `QueryTokenStream`): a version, whether there is an expression, then
 * the expression as a type (any/all/none of tags, or any/all/none of sub-expressions), a count and the tag indices or
 * the sub-expressions. Throws on a stream it does not understand, so a format change fails the build.
 */
export function decodeTagQuery(query: { TagDictionary?: Array<{ TagName?: string }>; QueryTokenStream?: number[] }): RewardCondition {
  const dictionary = (query.TagDictionary ?? []).map((t) => t.TagName ?? "");
  const stream = query.QueryTokenStream ?? [];
  if (stream.length === 0) return { match: "all", tags: [] };
  if (stream[0] !== 0) throw new Error(`Unknown tag query version ${stream[0]}`);
  if (stream[1] === 0) return { match: "all", tags: [] };
  let at = 2;
  const next = (): number => {
    const value = stream[at++];
    if (value === undefined) throw new Error("Tag query ends early");
    return value;
  };
  const readTags = (count: number): string[] =>
    Array.from({ length: count }, () => {
      const tag = dictionary[next()];
      if (tag === undefined) throw new Error("Tag query names a tag that is not in its dictionary");
      return tag;
    });
  const read = (depth: number): RewardCondition => {
    const type = next() as keyof typeof EXPRESSION_TYPES;
    const kind = EXPRESSION_TYPES[type];
    if (!kind) throw new Error(`Unknown tag query expression type ${type}`);
    const count = next();
    if (kind[1] === "tags") return { match: kind[0], tags: readTags(count) };
    if (depth > 0) throw new Error("Tag query nests deeper than two levels");
    const of = Array.from({ length: count }, () => {
      const part = read(depth + 1);
      return { match: part.match, tags: part.tags ?? [] };
    });
    return { match: kind[0], of };
  };
  const condition = read(0);
  if (at !== stream.length) throw new Error("Tag query has unread tokens");
  return condition;
}

const INTERPOLATION: Record<string, "constant" | "linear" | "cubic"> = { RCIM_Constant: "constant", RCIM_Linear: "linear", RCIM_Cubic: "cubic" };

function parseVariable(entry: Props): RewardVariable {
  const name = String(entry.Key);
  const v = entry.Value as Props;
  switch (String(v.VariableType).replace("EWDRewardCalculatorVariableType::", "")) {
    case "Literal":
      return { name, type: "literal", value: v.LiteralValue };
    case "GameValue":
      return { name, type: "game", game: v.GameValue };
    case "ScalingValue":
      return { name, type: "scaling", input: v.ScalingValueInput, curve: v.ScalingValueCurveTag?.TagName };
    default:
      throw new Error(`Reward variable ${name} has an unknown type ${v.VariableType}`);
  }
}

function parseResource(rewardId: string, resource: Props): RewardResource {
  const value = resource.Value as Props;
  const expression = value.DefaultExpression as Props;
  if (expression.ExpressionTableRow?.DataTable || expression.bSourceExpressionExternally) throw new Error(`Reward ${rewardId} reads its formula from a table, which is not supported`);
  if ((value.ConditionalExpressions ?? []).length) throw new Error(`Reward ${rewardId} has conditional formulas, which are not supported`);
  const variables = ((value.Variables ?? []) as Props[]).map(parseVariable);
  const inputs: RewardInput[] = ((value.Selectors ?? []) as Props[]).map((s) => ({
    name: String(s.Key),
    default: String(s.Value.DefaultOption),
    options: ((s.Value.Options ?? []) as Props[]).map((o) => ({ when: decodeTagQuery(o.Condition), use: String(o.Variable) })),
  }));

  // Every name the formula uses must resolve to an input or a variable, and every input must lead to a variable.
  const variableNames = new Set(variables.map((v) => v.name));
  const inputNames = new Set(inputs.map((i) => i.name));
  const where = `${rewardId} ${resource.Key?.TagName}`;
  for (const name of (expression.CompiledExpression?.Variables ?? []) as string[]) {
    if (!inputNames.has(name) && !variableNames.has(name)) throw new Error(`Reward ${where} uses ${name}, which is neither an input nor a variable`);
  }
  for (const input of inputs) for (const name of [input.default, ...input.options.map((o) => o.use)]) {
    if (!variableNames.has(name)) throw new Error(`Reward ${where}: input ${input.name} points at ${name}, which is not a variable`);
  }
  return {
    resource: strip(String(resource.Key?.TagName), "Attribute.Meta."),
    formula: String(expression.ExpressionString),
    inputs,
    variables,
  };
}

/** Parses a challenge reward table (`WDChallengeRewardDefinition`): one row per event, each paying one or more resources. */
export function parseChallengeRewards(exports: RawExport[]): ChallengeReward[] {
  const out: ChallengeReward[] = [];
  for (const exp of exports) {
    if (exp.Type !== "DataTable" || !exp.Rows) continue;
    if (!String(((exp.Properties ?? {}) as Props).RowStruct?.ObjectName ?? "").includes("WDChallengeRewardDefinition")) continue;
    for (const [key, row] of Object.entries(exp.Rows as Record<string, Props>)) {
      const id = strip(key, "Challenges.Rewards.");
      out.push({ id, resources: ((row.Resources ?? []) as Props[]).map((r) => parseResource(id, r)) });
    }
  }
  return out;
}

/**
 * Reads the curves a set of registration tables (`WDLiveCurveTableRow`: a tag and a curve asset) name. A curve asset
 * missing from the cache is an error: a reward could point at nothing.
 */
export function parseRewardCurves(tables: RawExport[][], index: Pick<PackageIndex, "load">): RewardCurve[] {
  const curves: RewardCurve[] = [];
  for (const exports of tables) {
    for (const exp of exports) {
      if (exp.Type !== "DataTable" || !exp.Rows) continue;
      for (const [id, row] of Object.entries(exp.Rows as Record<string, Props>)) {
        const path = row.CurveAsset?.ObjectPath as string | undefined;
        const asset = index.load(path)?.find((e) => e.Type === "CurveFloat");
        const keys = (asset?.Properties as Props | undefined)?.FloatCurve?.Keys as Props[] | undefined;
        if (!keys) throw new Error(`Curve ${id} points at ${path ?? "nothing"}, which is not in the cache`);
        curves.push({
          id,
          points: keys.map((k) => ({ input: k.Time, value: k.Value, interpolation: INTERPOLATION[String(k.InterpMode)] ?? failInterpolation(id, k.InterpMode) })),
        });
      }
    }
  }
  return curves.sort((a, b) => a.id.localeCompare(b.id));
}

function failInterpolation(id: string, mode: unknown): never {
  throw new Error(`Curve ${id} uses the unknown interpolation ${String(mode)}`);
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

const text = (v: unknown): string | undefined => {
  const t = v as { LocalizedString?: string | null; SourceString?: string | null; CultureInvariantString?: string | null } | undefined;
  return (t?.LocalizedString ?? t?.SourceString ?? t?.CultureInvariantString)?.replace(/\r\n?/g, "\n").trim() || undefined;
};

/** `WDChallengeDefinition` rows tagged `Challenges.SessionEvents.*`: the name and note of each in-match event. */
export function parseRewardEvents(exports: RawExport[]): RewardEvent[] {
  const events: RewardEvent[] = [];
  for (const exp of exports) {
    if (exp.Type !== "DataTable" || !exp.Rows || !String(((exp.Properties ?? {}) as Props).RowStruct?.ObjectName ?? "").includes("WDChallengeDefinition")) continue;
    for (const [key, row] of Object.entries(exp.Rows as Record<string, Props>)) {
      if (!key.startsWith("Challenges.SessionEvents.")) continue;
      const name = text(row.DisplayName);
      if (!name) continue;
      const description = text(row.Description);
      events.push({ id: strip(key, "Challenges.SessionEvents."), name, ...(description ? { description } : {}) });
    }
  }
  return events;
}

const read = (file: string): RawExport[] => JSON.parse(readFileSync(file, "utf8")) as RawExport[];

export interface ChallengeRewardsBuild {
  events: RewardEvent[];
  rewards: ChallengeReward[];
  curves: RewardCurve[];
}

/**
 * Builds the reward formulas and the curves they use from the cache. Every curve a reward names must exist, and every
 * curve registered is published, so a reward that points at a missing curve fails the build.
 */
export function buildChallengeRewards(rawDir: string, index: Pick<PackageIndex, "load">): ChallengeRewardsBuild {
  const all = [...walk(join(rawDir, "items"))];
  const rewards = all
    .filter((f) => /[\\/]DT_ChallengeRewards_[^\\/]*\.json$/.test(f))
    .flatMap((f) => parseChallengeRewards(read(f)))
    .sort((a, b) => a.id.localeCompare(b.id));
  const duplicate = rewards.find((r, i) => rewards[i + 1]?.id === r.id);
  if (duplicate) throw new Error(`Reward ${duplicate.id} is defined twice`);

  const events = all
    .filter((f) => /[\\/]DT_Challenges_SessionEvents_[^\\/]*\.json$/.test(f))
    .flatMap((f) => parseRewardEvents(read(f)))
    .sort((a, b) => a.id.localeCompare(b.id));
  const repeated = events.find((e, i) => events[i + 1]?.id === e.id);
  if (repeated) throw new Error(`Event ${repeated.id} is defined twice`);

  const curves = parseRewardCurves(
    all.filter((f) => /[\\/](DT_Challenges_Curves_[^\\/]*|DT_Meta_RewardScalingCurves)\.json$/.test(f)).map(read),
    index,
  );
  const known = new Set(curves.map((c) => c.id));
  for (const reward of rewards) for (const resource of reward.resources) for (const v of resource.variables) {
    if (v.type === "scaling" && !known.has(v.curve)) throw new Error(`Reward ${reward.id} scales by ${v.curve}, which is not a registered curve`);
  }
  return { events, rewards, curves };
}
