import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChallengeRewardsFile, type RewardCondition } from "../src/schema.gameplay.js";
import { decodeTagQuery, parseChallengeRewards, parseRewardCurves, parseRewardEvents } from "../src/transform/challengeRewards.js";
import type { RawExport } from "../src/transform/items.js";

const dictionary = (...tags: string[]) => tags.map((TagName) => ({ TagName }));

describe("decodeTagQuery", () => {
  it("reads all/any/none of tags", () => {
    expect(decodeTagQuery({ TagDictionary: dictionary("A"), QueryTokenStream: [0, 1, 2, 1, 0] })).toEqual({ match: "all", tags: ["A"] });
    expect(decodeTagQuery({ TagDictionary: dictionary("A", "B"), QueryTokenStream: [0, 1, 1, 2, 0, 1] })).toEqual({ match: "any", tags: ["A", "B"] });
    expect(decodeTagQuery({ TagDictionary: dictionary("A"), QueryTokenStream: [0, 1, 3, 1, 0] })).toEqual({ match: "none", tags: ["A"] });
  });

  it("reads groups of tags combined with all/any/none", () => {
    // ALL( ALL(A), NONE(B) )
    expect(decodeTagQuery({ TagDictionary: dictionary("A", "B"), QueryTokenStream: [0, 1, 5, 2, 2, 1, 0, 3, 1, 1] })).toEqual({
      match: "all",
      of: [{ match: "all", tags: ["A"] }, { match: "none", tags: ["B"] }],
    });
    // ANY( ALL(A, B), ALL(A, C) ): a tag may be used by several groups
    expect(decodeTagQuery({ TagDictionary: dictionary("A", "B", "C"), QueryTokenStream: [0, 1, 4, 2, 2, 2, 0, 1, 2, 2, 0, 2] })).toEqual({
      match: "any",
      of: [{ match: "all", tags: ["A", "B"] }, { match: "all", tags: ["A", "C"] }],
    });
  });

  it("treats an empty query as always true", () => {
    expect(decodeTagQuery({})).toEqual({ match: "all", tags: [] });
    expect(decodeTagQuery({ TagDictionary: [], QueryTokenStream: [0, 0] })).toEqual({ match: "all", tags: [] });
  });

  it("fails on streams it does not understand, rather than guess", () => {
    expect(() => decodeTagQuery({ TagDictionary: dictionary("A"), QueryTokenStream: [1, 1, 2, 1, 0] })).toThrow(/version/);
    expect(() => decodeTagQuery({ TagDictionary: dictionary("A"), QueryTokenStream: [0, 1, 9, 1, 0] })).toThrow(/type 9/);
    expect(() => decodeTagQuery({ TagDictionary: dictionary("A"), QueryTokenStream: [0, 1, 2, 1, 4] })).toThrow(/dictionary/);
    expect(() => decodeTagQuery({ TagDictionary: dictionary("A"), QueryTokenStream: [0, 1, 2, 2, 0] })).toThrow(/early/);
    expect(() => decodeTagQuery({ TagDictionary: dictionary("A"), QueryTokenStream: [0, 1, 2, 1, 0, 7] })).toThrow(/unread/);
    expect(() => decodeTagQuery({ TagDictionary: dictionary("A"), QueryTokenStream: [0, 1, 4, 1, 4, 1, 4, 1, 2, 1, 0] })).toThrow(/deeper/);
  });
});

const literal = (name: string, value: number): { Key: string; Value: Record<string, unknown> } => ({ Key: name, Value: { VariableType: "EWDRewardCalculatorVariableType::Literal", LiteralValue: value } });
const expression = (text: string, variables: string[]) => ({ ExpressionString: text, ExpressionTableRow: { DataTable: null }, bSourceExpressionExternally: false, CompiledExpression: { Variables: variables } });
const rewardTable = (rows: Record<string, unknown>): RawExport[] => [{ Type: "DataTable", Properties: { RowStruct: { ObjectName: "Class'WDChallengeRewardDefinition'" } } as never, Rows: rows as never }];

describe("parseChallengeRewards", () => {
  const row = (extra: Record<string, unknown> = {}) => ({
    Resources: [
      {
        Key: { TagName: "Attribute.Meta.Currency.Cash" },
        Value: {
          DefaultExpression: expression("Base * Bonus", ["Base", "Bonus"]),
          ConditionalExpressions: [],
          Selectors: [
            { Key: "Base", Value: { DefaultOption: "DefaultReward", Options: [{ Condition: { TagDictionary: dictionary("Challenges.Context.Headshot"), QueryTokenStream: [0, 1, 2, 1, 0] }, Variable: "HeadshotReward" }] } },
            { Key: "Bonus", Value: { DefaultOption: "One", Options: [] } },
          ],
          Variables: [literal("DefaultReward", 300), literal("HeadshotReward", 350), literal("One", 1)],
          ...extra,
        },
      },
    ],
  });

  it("reads the formula, the situational inputs and the numbers, dropping the prefixes", () => {
    const [reward] = parseChallengeRewards(rewardTable({ "Challenges.Rewards.PlayerKill": row() }));
    expect(reward).toEqual({
      id: "PlayerKill",
      resources: [
        {
          resource: "Currency.Cash",
          formula: "Base * Bonus",
          inputs: [
            { name: "Base", default: "DefaultReward", options: [{ when: { match: "all", tags: ["Challenges.Context.Headshot"] }, use: "HeadshotReward" }] },
            { name: "Bonus", default: "One", options: [] },
          ],
          variables: [
            { name: "DefaultReward", type: "literal", value: 300 },
            { name: "HeadshotReward", type: "literal", value: 350 },
            { name: "One", type: "literal", value: 1 },
          ],
        },
      ],
    });
  });

  it("reads game values and curve-scaled values", () => {
    const value = row().Resources[0]!.Value;
    value.Variables.push(
      { Key: "Streak", Value: { VariableType: "EWDRewardCalculatorVariableType::GameValue", GameValue: "KillStreak" } },
      { Key: "Far", Value: { VariableType: "EWDRewardCalculatorVariableType::ScalingValue", ScalingValueInput: "DistanceToTarget", ScalingValueCurveTag: { TagName: "LiveCurves.X" } } },
    );
    const vars = parseChallengeRewards(rewardTable({ "Challenges.Rewards.A": { Resources: [{ Key: { TagName: "Attribute.Meta.XP.Role" }, Value: value }] } }))[0]!.resources[0]!.variables;
    expect(vars.slice(-2)).toEqual([
      { name: "Streak", type: "game", game: "KillStreak" },
      { name: "Far", type: "scaling", input: "DistanceToTarget", curve: "LiveCurves.X" },
    ]);
  });

  it("fails when a name resolves to nothing, an input points at a missing variable, or the format is not the supported one", () => {
    const withValue = (patch: (v: ReturnType<typeof row>["Resources"][0]["Value"]) => void) => {
      const r = row();
      patch(r.Resources[0]!.Value);
      return rewardTable({ "Challenges.Rewards.Bad": r });
    };
    expect(() => parseChallengeRewards(withValue((v) => (v.DefaultExpression = expression("Missing", ["Missing"]))))).toThrow(/Missing, which is neither/);
    expect(() => parseChallengeRewards(withValue((v) => (v.Selectors[1]!.Value.DefaultOption = "Nope")))).toThrow(/Nope, which is not a variable/);
    expect(() => parseChallengeRewards(withValue((v) => (v.ConditionalExpressions = [{}] as never)))).toThrow(/conditional/);
    expect(() => parseChallengeRewards(withValue((v) => (v.DefaultExpression.bSourceExpressionExternally = true)))).toThrow(/table/);
    expect(() => parseChallengeRewards(withValue((v) => v.Variables.push({ Key: "Odd", Value: { VariableType: "EWDRewardCalculatorVariableType::Strange" } } as never)))).toThrow(/unknown type/);
  });

  it("ignores tables of other kinds", () => {
    expect(parseChallengeRewards([{ Type: "DataTable", Properties: { RowStruct: { ObjectName: "Class'Other'" } } as never, Rows: { X: {} } as never }])).toEqual([]);
  });
});

describe("parseRewardCurves", () => {
  const registry = (rows: Record<string, string>): RawExport[] => [{ Type: "DataTable", Rows: Object.fromEntries(Object.entries(rows).map(([tag, path]) => [tag, { CurveAsset: { ObjectPath: path } }])) as never }];
  const curve = (...keys: Array<[number, number, string]>): RawExport[] => [{ Type: "CurveFloat", Properties: { FloatCurve: { Keys: keys.map(([Time, Value, InterpMode]) => ({ Time, Value, InterpMode })) } } as never }];

  it("reads each registered curve's points, sorted by id", () => {
    const assets: Record<string, RawExport[]> = { "/Game/B.0": curve([0, 1, "RCIM_Constant"], [10, 2, "RCIM_Linear"]), "/Game/A.0": curve([0, 5, "RCIM_Cubic"]) };
    const index = { load: (p: string | undefined | null) => assets[p ?? ""] };
    expect(parseRewardCurves([registry({ "LiveCurves.B": "/Game/B.0", "LiveCurves.A": "/Game/A.0" })], index)).toEqual([
      { id: "LiveCurves.A", points: [{ input: 0, value: 5, interpolation: "cubic" }] },
      { id: "LiveCurves.B", points: [{ input: 0, value: 1, interpolation: "constant" }, { input: 10, value: 2, interpolation: "linear" }] },
    ]);
  });

  it("fails on a curve that is not in the cache or an interpolation it does not know", () => {
    expect(() => parseRewardCurves([registry({ "LiveCurves.Gone": "/Game/Gone.0" })], { load: () => undefined })).toThrow(/LiveCurves\.Gone/);
    expect(() => parseRewardCurves([registry({ "LiveCurves.Odd": "/Game/Odd.0" })], { load: () => curve([0, 1, "RCIM_Weird"]) })).toThrow(/RCIM_Weird/);
  });
});

describe("parseRewardEvents", () => {
  const rows = (entries: Record<string, unknown>): RawExport[] => [
    { Type: "DataTable", Properties: { RowStruct: { ObjectName: "Class'WDChallengeDefinition'" } } as never, Rows: entries as never },
  ];

  it("reads the name and note of each session event and skips achievements and unnamed rows", () => {
    expect(
      parseRewardEvents(
        rows({
          "Challenges.SessionEvents.RevivePlayer": { DisplayName: { LocalizedString: "Revive Player" }, Description: { LocalizedString: "Award resources to a player when they revive another player." } },
          "Challenges.SessionEvents.Tip": { DisplayName: { LocalizedString: "Send & Receive Tip" }, Description: { CultureInvariantString: null } },
          "Challenges.SessionEvents.Unnamed": {},
          "Achievement.Combat.LongShot": { DisplayName: { LocalizedString: "Long Shot" } },
        }),
      ),
    ).toEqual([
      { id: "RevivePlayer", name: "Revive Player", description: "Award resources to a player when they revive another player." },
      { id: "Tip", name: "Send & Receive Tip" },
    ]);
  });
});

describe("data/challenge-rewards.json events", () => {
  const file = ChallengeRewardsFile.parse(JSON.parse(readFileSync("data/challenge-rewards.json", "utf8")));

  it("lists the game's event definitions, sorted and unique, with the revive event worded as in the game", () => {
    expect(file.events.length).toBeGreaterThanOrEqual(70);
    expect(file.events.map((e) => e.id)).toEqual([...file.events.map((e) => e.id)].sort((a, b) => a.localeCompare(b)));
    expect(new Set(file.events.map((e) => e.id)).size).toBe(file.events.length);
    expect(file.events.find((e) => e.id === "RevivePlayer")).toEqual({ id: "RevivePlayer", name: "Revive Player", description: "Award resources to a player when they revive another player." });
  });
});

describe("data/challenge-rewards.json", () => {
  const file = ChallengeRewardsFile.parse(JSON.parse(readFileSync("data/challenge-rewards.json", "utf8")));
  const reward = (id: string) => file.rewards.find((r) => r.id === id)!;
  const resource = (id: string, name: string) => reward(id).resources.find((r) => r.resource === name)!;
  const variable = (id: string, name: string, variableName: string) => resource(id, name).variables.find((v) => v.name === variableName);

  it("keeps the rewards and curves populated, sorted, unique and cross-referenced", () => {
    expect(file.rewards.length).toBeGreaterThanOrEqual(230);
    expect(file.curves.length).toBeGreaterThanOrEqual(16);
    expect(file.rewards.map((r) => r.id)).toEqual([...file.rewards.map((r) => r.id)].sort((a, b) => a.localeCompare(b)));
    expect(new Set(file.rewards.map((r) => r.id)).size).toBe(file.rewards.length);
    const curves = new Set(file.curves.map((c) => c.id));
    for (const r of file.rewards) for (const p of r.resources) for (const v of p.variables) if (v.type === "scaling") expect(curves.has(v.curve), `${r.id} ${v.curve}`).toBe(true);
    for (const c of file.curves) expect(c.points.map((p) => p.input), c.id).toEqual([...c.points.map((p) => p.input)].sort((a, b) => a - b));
  });

  it("pays cash for every event, and role XP for most", () => {
    for (const r of file.rewards) expect(r.resources.some((p) => p.resource === "Currency.Cash"), r.id).toBe(true);
    expect(file.rewards.filter((r) => r.resources.some((p) => p.resource === "XP.Role")).length).toBeGreaterThanOrEqual(200);
  });

  it("canaries: values read from the game's tables", () => {
    expect(variable("PlayerKill", "Currency.Cash", "DefaultReward")).toEqual({ name: "DefaultReward", type: "literal", value: 300 });
    expect(variable("PlayerKill", "Currency.Cash", "HeadshotReward")).toEqual({ name: "HeadshotReward", type: "literal", value: 350 });
    expect(variable("PlayerKill", "XP.Role", "DefaultReward")).toEqual({ name: "DefaultReward", type: "literal", value: 250 });
    expect(variable("PlayerKill", "Currency.Cash", "FriendlyFactor")).toEqual({ name: "FriendlyFactor", type: "literal", value: -3 });
    expect(variable("PlayerKill", "Currency.Cash", "RevengeFactor")).toEqual({ name: "RevengeFactor", type: "literal", value: 2 });
    expect(resource("PlayerKill", "Currency.Cash").formula).toContain("pow(CrewPenaltyModifier, clamp(CrewCount - 1, 0, CrewCountMax))");
    expect(reward("EndOfMatchFactionReward.FirstPlace").resources[0]).toMatchObject({ resource: "Currency.Cash", formula: "1000" });
    expect(reward("EndOfMatchFactionReward.SecondPlace").resources[0]).toMatchObject({ formula: "500" });
  });

  it("canaries: the headshot reward applies when a headshot is not an artillery strike", () => {
    const input = resource("PlayerKill", "Currency.Cash").inputs.find((i) => i.name === "BaseReward")!;
    expect(input.default).toBe("DefaultReward");
    expect(input.options.find((o) => o.use === "HeadshotReward")?.when).toEqual({
      match: "all",
      of: [{ match: "all", tags: ["Challenges.Context.Headshot"] }, { match: "none", tags: ["Challenges.Context.PrecisionArtilleryStrikeKill"] }],
    });
  });

  it("canaries: the kill distance curve is a step function in the game's units", () => {
    const curve = file.curves.find((c) => c.id === "LiveCurves.Challenges.SessionEvents.PlayerKill.DistanceScalar")!;
    expect(curve.points.slice(0, 3).map((p) => [p.input, p.value])).toEqual([[0, 1], [30000, 1.5], [40000, 2]]);
    expect(new Set(curve.points.map((p) => p.interpolation))).toEqual(new Set(["constant"]));
    const scalar = file.curves.find((c) => c.id === "Challenges.Rewards.MatchScoreScalar")!;
    expect(scalar.points.map((p) => [p.input, p.value])).toEqual([[18, 0.6], [21, 0.7], [24, 0.8], [27, 0.9], [30, 1]]);
  });
});

const render = (c: RewardCondition): string => {
  const parts = c.of ? c.of.map((g) => `${g.match.toUpperCase()}( ${g.tags.join(", ")} )`) : (c.tags ?? []);
  return `${c.match.toUpperCase()}( ${parts.join(", ")} )`;
};

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else if (/DT_ChallengeRewards_[^/\\]*\.json$/.test(full)) yield full;
  }
}

describe.skipIf(!existsSync(".cache/raw/items"))("challenge rewards against the raw cache", () => {
  // describe.skipIf still runs this body to collect the tests, so read the cache only when it is there.
  const raw = !existsSync(".cache/raw/items") ? [] : [...files(".cache/raw/items")].flatMap((f) => (JSON.parse(readFileSync(f, "utf8")) as RawExport[]).flatMap((e) => Object.entries((e.Rows ?? {}) as Record<string, any>)));
  const published = ChallengeRewardsFile.parse(JSON.parse(readFileSync("data/challenge-rewards.json", "utf8")));

  it("publishes every row, and every resource of every row", () => {
    expect(published.rewards.length).toBe(raw.length);
    for (const [key, row] of raw) {
      const out = published.rewards.find((r) => r.id === key.replace("Challenges.Rewards.", ""))!;
      expect(out.resources.map((r) => `Attribute.Meta.${r.resource}`), key).toEqual(row.Resources.map((r: any) => r.Key.TagName));
      out.resources.forEach((r, i) => {
        const value = row.Resources[i].Value;
        expect(r.formula).toBe(value.DefaultExpression.ExpressionString);
        expect(r.variables.length).toBe(value.Variables.length);
        expect(r.inputs.length).toBe(value.Selectors.length);
      });
    }
  });

  it("decodes every condition to the text the game itself wrote for it", () => {
    let checked = 0;
    for (const [key, row] of raw) {
      for (const resource of row.Resources) {
        for (const selector of resource.Value.Selectors) {
          for (const option of selector.Value.Options) {
            const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
            expect(normalize(render(decodeTagQuery(option.Condition))), `${key} ${selector.Key}`).toBe(normalize(option.Condition.AutoDescription));
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});
