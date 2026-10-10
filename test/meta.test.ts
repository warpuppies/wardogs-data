import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CosmeticsFile, MetaFile } from "../src/schema.gameplay.js";
import type { RawExport } from "../src/transform/items.js";
import { buildMetaData, parseAchievementChallenges, parseAchievements, parseCurrencies, parseCurrentSeason, parseGoldMarket, parsePassiveChallenges, parsePassiveMissions, ticksToIso } from "../src/transform/meta.js";

const table = (struct: string, rows: Record<string, unknown>): RawExport[] => [
  { Type: "DataTable", Properties: { RowStruct: { ObjectName: `Class'${struct}'` } } as never, Rows: rows as never },
];
const loc = (v: string) => ({ LocalizedString: v, SourceString: v });
const tag = (v: string) => ({ TagName: v });

const challengeRow = (name: string, objective: string, value: number, intel: number) => ({
  DisplayName: loc(name),
  Description: loc(`${name} X`),
  Rewards: [{ RewardTag: tag("Attribute.Meta.Currency.Intel"), Type: "EGameDataMetaRewardType::REWARD_TYPE_INVALID", Quantity: intel }],
  Objectives: [{ Key: tag(`Challenges.Objective.${objective}`), Value: value }],
});

describe("ticksToIso", () => {
  it("converts game ticks to UTC and treats 0 as unset", () => {
    expect(ticksToIso(639342720000000000)).toBe("2026-12-31T00:00:00.000Z");
    expect(ticksToIso(621355968000000000)).toBe("1970-01-01T00:00:00.000Z");
    expect(ticksToIso(0)).toBeUndefined();
    expect(ticksToIso(undefined)).toBeUndefined();
  });
});

describe("parseCurrencies", () => {
  it("reads names and starting balances, sorted by id", () => {
    const { currencies } = parseCurrencies(
      table("WDCurrencyDefinition", {
        "Attribute.Meta.Currency.GoldBars": { DisplayName: loc("Gold Bars"), InitialBalance: 0 },
        "Attribute.Meta.Currency.Cash": { DisplayName: loc("Cash"), InitialBalance: 10000 },
        "Attribute.Meta.Currency.Broken": { InitialBalance: 5 },
      }),
    );
    expect(currencies).toEqual([
      { id: "Cash", name: "Cash", initialBalance: 10000 },
      { id: "GoldBars", name: "Gold Bars", initialBalance: 0 },
    ]);
  });
});

describe("parseGoldMarket", () => {
  const row = (extra: object = {}) => ({
    GoldBarCost: 5,
    Category: tag("Meta.Cosmetic.DigitalWood"),
    EntityID: tag("Id.Item.Glock17"),
    GridIndex: 2,
    TileSize: "EGameDataUITileSize::LARGE_SQUARE",
    ExpirationType: "EGameDataExpirationType::NO_EXPIRATION",
    ExpirationTime: { Ticks: 0 },
    ...extra,
  });

  it("strips the tag prefix, names the enums and keeps a stored time", () => {
    const offers = parseGoldMarket(
      table("WDGoldMarketItemTableRow", {
        "Meta.Cosmetic.DigitalWood.GGX17": row(),
        "Meta.Cosmetic.BlackAndGold.AK74": row({ ExpirationType: "EGameDataExpirationType::EXPIRATION_NO_END_TIME", ExpirationTime: { Ticks: 639342720000000000 } }),
      }),
    );
    expect(offers.map((o) => o.id)).toEqual(["BlackAndGold.AK74", "DigitalWood.GGX17"]);
    expect(offers[0]).toMatchObject({ expiration: "EXPIRATION_NO_END_TIME", expirationTime: "2026-12-31T00:00:00.000Z" });
    expect(offers[1]).toEqual({ id: "DigitalWood.GGX17", category: "DigitalWood", entity: "Id.Item.Glock17", goldBars: 5, gridIndex: 2, tile: "LARGE_SQUARE", expiration: "NO_EXPIRATION" });
  });

  it("skips a row with no entity", () => {
    expect(parseGoldMarket(table("WDGoldMarketItemTableRow", { "Meta.Cosmetic.X.Y": row({ EntityID: tag("None") }) }))).toEqual([]);
  });
});

describe("passive missions", () => {
  const challenges = parsePassiveChallenges(
    table("WDChallengeDefinition", {
      "Challenges.Challenge.Mission.Passive.EarnCash.1": challengeRow("Earn Cash", "CashEarned", 5000, 100),
      "Challenges.Challenge.Mission.Passive.EarnCash.2": challengeRow("Earn Cash", "CashEarned", 12000, 200),
    }),
  );

  it("reads a tier's objective, target and reward", () => {
    expect(challenges.get("Challenges.Challenge.Mission.Passive.EarnCash.2")).toEqual({
      id: "EarnCash.2",
      name: "Earn Cash",
      description: "Earn Cash X",
      objective: "CashEarned",
      target: 12000,
      reward: { currency: "Intel", amount: 200 },
    });
  });

  it("joins a mission to its tiers in the game's order", () => {
    const missions = parsePassiveMissions(
      table("WDMissionDefinition", {
        "Mission.Passive.EarnCash": { DifficultyWeight: 1, Challenges: [tag("Challenges.Challenge.Mission.Passive.EarnCash.2"), tag("Challenges.Challenge.Mission.Passive.EarnCash.1")] },
      }),
      challenges,
    );
    expect(missions).toHaveLength(1);
    expect(missions[0]).toMatchObject({ id: "EarnCash", difficultyWeight: 1 });
    expect(missions[0]!.challenges.map((c) => c.id)).toEqual(["EarnCash.2", "EarnCash.1"]);
  });

  it("fails on a tier the challenge table does not define", () => {
    expect(() => parsePassiveMissions(table("WDMissionDefinition", { "Mission.Passive.X": { Challenges: [tag("Challenges.Challenge.Mission.Passive.X.1")] } }), challenges)).toThrow(/X\.1/);
  });
});

describe("parseAchievements and parseCurrentSeason", () => {
  it("reads the Steam id and name, and from the challenge table the description and the condition's numbers", () => {
    const rows = table("WDAchievementDefinition", {
      "Achievement.Combat.LongShot": { SteamAchievementID: "ACH_COMBAT_LONG_SHOT", DisplayName: loc("Long Shot") },
      "Achievement.Combat.RicochetKill": { SteamAchievementID: "ACH_COMBAT_RICOCHET_KILL", DisplayName: loc("Ricochet Kill") },
    });
    const bag = { PropertyDescs: [{ Name: "DistanceThreshold", ValueType: "EPropertyBagPropertyType::Float", ContainerTypes: { Types: [] } }], SerialSize: 6, Data: Buffer.from("0003008cb947", "hex").toString("base64") };
    const challenges = parseAchievementChallenges(
      table("WDChallengeDefinition", {
        "Achievement.Combat.RicochetKill": { Description: loc("Kill an enemy with a ricocheted projectile."), StateTreeReference: { Parameters: { PropertyDescs: [], SerialSize: 0 } } },
        "Achievement.Combat.LongShot": { Description: { CultureInvariantString: null }, StateTreeReference: { Parameters: bag } },
        "Challenges.SessionEvents.PlayerKill": { Description: loc("Not an achievement.") },
      }),
    );
    expect(parseAchievements(rows, challenges)).toEqual([
      { id: "Combat.LongShot", steamId: "ACH_COMBAT_LONG_SHOT", name: "Long Shot", thresholds: { DistanceThreshold: 95000 } },
      { id: "Combat.RicochetKill", steamId: "ACH_COMBAT_RICOCHET_KILL", name: "Ricochet Kill", description: "Kill an enemy with a ricocheted projectile." },
    ]);
  });

  it("reads the current season number", () => {
    expect(parseCurrentSeason(table("WDMetaSeasonDefinitionTableRow", { "Meta.Season.Definitions": { CurrentSeasonNumber: 1, SeasonDefinitions: [] } }))).toBe(1);
    expect(parseCurrentSeason(table("WDMetaSeasonDefinitionTableRow", {}))).toBeUndefined();
  });
});

describe("buildMetaData", () => {
  const put = (raw: string, path: string, value: unknown) => {
    mkdirSync(dirname(join(raw, path)), { recursive: true });
    writeFileSync(join(raw, path), JSON.stringify(value));
  };

  it("builds data/meta.json from the tables, and fails when one is missing", () => {
    const raw = mkdtempSync(join(tmpdir(), "wardogs-meta-"));
    const base = "items/Wardogs/Content/Meta";
    put(raw, `${base}/CurrencyDefinitions/DT_CurrenciesDefinitions.json`, table("WDCurrencyDefinition", { "Attribute.Meta.Currency.Cash": { DisplayName: loc("Cash"), InitialBalance: 10000 } }));
    put(raw, `${base}/Collection/DT_GoldMarket.json`, table("WDGoldMarketItemTableRow", {}));
    put(raw, `${base}/Missions/DT_PassiveMissionChallenges.json`, table("WDChallengeDefinition", { "Challenges.Challenge.Mission.Passive.TimePlayed.1": challengeRow("Time Played", "TimePlayed", 1800, 100) }));
    put(raw, `${base}/Missions/DT_PassiveMissions.json`, table("WDMissionDefinition", { "Mission.Passive.TimePlayed": { DifficultyWeight: 1, Challenges: [tag("Challenges.Challenge.Mission.Passive.TimePlayed.1")] } }));
    put(raw, `${base}/Challenges/DT_Challenges_SessionEvents_Shared.json`, table("WDChallengeDefinition", { "Achievement.Match.CleanSweep": { Description: loc("Win a KOTH match without the opposing faction scoring.") } }));
    put(raw, `${base}/Achievements/DT_Achievements.json`, table("WDAchievementDefinition", { "Achievement.Match.CleanSweep": { SteamAchievementID: "ACH_MATCH_CLEAN_SWEEP", DisplayName: loc("Clean Sweep") } }));
    expect(() => buildMetaData(raw, "7")).toThrow(/DT_SeasonDefinitions/);
    put(raw, `${base}/DT_SeasonDefinitions.json`, table("WDMetaSeasonDefinitionTableRow", { "Meta.Season.Definitions": { CurrentSeasonNumber: 1 } }));
    const { files, notes } = buildMetaData(raw, "7");
    expect(files.map((f) => f.path)).toEqual(["data/meta.json"]);
    const meta = MetaFile.parse(JSON.parse(files[0]!.content));
    expect(meta).toMatchObject({ gameBuild: "7", currentSeason: 1, currencies: [{ id: "Cash", initialBalance: 10000 }], achievements: [{ id: "Match.CleanSweep", description: "Win a KOTH match without the opposing faction scoring." }] });
    expect(meta.passiveMissions[0]!.challenges[0]).toMatchObject({ objective: "TimePlayed", target: 1800 });
    expect(notes[0]).toContain("1 currencies, 0 gold market offers, 1 passive missions with 1 tiers, 1 achievements, season 1");
  });
});

describe("meta data", () => {
  const meta = MetaFile.parse(JSON.parse(readFileSync("data/meta.json", "utf8")));
  const cosmetics = CosmeticsFile.parse(JSON.parse(readFileSync("data/cosmetics.json", "utf8"))).cosmetics;

  it("canaries: a new profile starts with 10,000 cash and no gold bars", () => {
    expect(meta.currencies.map((c) => [c.id, c.initialBalance])).toEqual([["Cash", 10000], ["GoldBars", 0]]);
  });

  it("canaries: the three passive missions have five tiers each paying 100 to 500 Intel", () => {
    expect(meta.passiveMissions.map((m) => m.id)).toEqual(["EarnAnyRoleXp", "EarnCash", "TimePlayed"]);
    for (const m of meta.passiveMissions) expect(m.challenges.map((c) => c.reward.amount), m.id).toEqual([100, 200, 300, 400, 500]);
    const cash = meta.passiveMissions.find((m) => m.id === "EarnCash")!;
    expect(cash.challenges.map((c) => c.target)).toEqual([5000, 12000, 30000, 80000, 200000]);
  });

  it("canaries: Clean Sweep is described as winning a KOTH match without the other side scoring", () => {
    expect(meta.achievements.find((a) => a.id === "Match.CleanSweep")?.description).toBe("Win a KOTH match without the opposing faction scoring.");
  });

  it("canaries: the achievement thresholds are 100,000 cash, 3,600 seconds and 95,000 units", () => {
    const threshold = (id: string) => meta.achievements.find((a) => a.id === id)?.thresholds;
    expect(threshold("Economy.LoadoutSpend")).toEqual({ CashThreshold: 100000 });
    expect(threshold("Economy.SingleLifeProfit")).toEqual({ CashThreshold: 100000 });
    expect(threshold("Survival.ControlZoneSurvivor")).toEqual({ RequiredSeconds: 3600 });
    expect(threshold("Combat.LongShot")).toEqual({ DistanceThreshold: 95000 });
    expect(meta.achievements.filter((a) => a.thresholds).length).toBe(4);
  });

  it("keeps the gold market and achievements populated", () => {
    expect(meta.goldMarket.length).toBeGreaterThanOrEqual(20);
    expect(meta.achievements.length).toBeGreaterThanOrEqual(10);
    expect(new Set(meta.achievements.map((a) => a.steamId)).size).toBe(meta.achievements.length);
  });

  it("every gold market offer is a cosmetic of cosmetics.json, for the same entity", () => {
    const byId = new Map(cosmetics.map((c) => [c.id, c]));
    for (const o of meta.goldMarket) {
      const c = byId.get(o.id);
      expect(c, o.id).toBeDefined();
      expect(c!.item.toLowerCase(), o.id).toBe(o.entity.toLowerCase());
    }
  });
});
