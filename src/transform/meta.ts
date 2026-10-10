import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GeneratedFile } from "../generated.js";
import { MetaFile, type Achievement, type Currency, type GoldMarketOffer, type PassiveChallenge, type PassiveMission } from "../schema.gameplay.js";
import type { RawExport } from "./items.js";
import { decodeNumberBag } from "./propertyBag.js";

type Props = Record<string, any>; // decoded game properties: shapes are checked field by field below

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const tagName = (v: unknown): string | undefined => {
  const name = (v as { TagName?: unknown } | undefined)?.TagName;
  return typeof name === "string" && name !== "None" ? name : undefined;
};
const strip = (value: string, prefix: string): string => (value.startsWith(prefix) ? value.slice(prefix.length) : value);
const enumName = (v: unknown): string => String(v ?? "").replace(/^E[A-Za-z]+::/, "");
const text = (v: unknown): string | undefined => {
  const t = v as { LocalizedString?: string | null; SourceString?: string | null; CultureInvariantString?: string | null } | undefined;
  return (t?.LocalizedString ?? t?.SourceString ?? t?.CultureInvariantString)?.replace(/\r\n?/g, "\n").trim() || undefined;
};

function* tableRows(exports: RawExport[], struct: string): Generator<{ key: string; row: Props }> {
  for (const exp of exports) {
    if (exp.Type !== "DataTable" || !exp.Rows) continue;
    if (!String(((exp.Properties ?? {}) as Props).RowStruct?.ObjectName ?? "").includes(struct)) continue;
    for (const [key, row] of Object.entries(exp.Rows)) yield { key, row: row as Props };
  }
}

/** Ticks of 100 ns since 0001-01-01 (the game's date type) as an ISO time, or undefined for the unset value 0. */
export function ticksToIso(ticks: unknown): string | undefined {
  const n = typeof ticks === "number" || typeof ticks === "bigint" ? Number(ticks) : undefined;
  if (n === undefined || !Number.isFinite(n) || n <= 0) return undefined;
  const ms = (n - 621355968000000000) / 10000; // ticks at the Unix epoch
  return Number.isFinite(ms) ? new Date(Math.round(ms)).toISOString() : undefined;
}

/** `WDCurrencyDefinition`: the display name and the balance of a new profile. */
export function parseCurrencies(exports: RawExport[]): { currencies: Currency[] } {
  const currencies: Currency[] = [];
  for (const { key, row } of tableRows(exports, "WDCurrencyDefinition")) {
    const name = text(row.DisplayName);
    const initialBalance = num(row.InitialBalance);
    if (!name || initialBalance === undefined) continue;
    currencies.push({ id: strip(key, "Attribute.Meta.Currency."), name, initialBalance });
  }
  return { currencies: currencies.sort((a, b) => a.id.localeCompare(b.id)) };
}

/** `WDGoldMarketItemTableRow`: one row per cosmetic sold for gold bars. */
export function parseGoldMarket(exports: RawExport[]): GoldMarketOffer[] {
  const offers: GoldMarketOffer[] = [];
  for (const { key, row } of tableRows(exports, "WDGoldMarketItemTableRow")) {
    const entity = tagName(row.EntityID);
    const category = tagName(row.Category);
    const goldBars = num(row.GoldBarCost);
    const gridIndex = num(row.GridIndex);
    if (!entity || !category || goldBars === undefined || gridIndex === undefined) continue;
    const expirationTime = ticksToIso(row.ExpirationTime?.Ticks);
    offers.push({
      id: strip(key, "Meta.Cosmetic."),
      category: strip(category, "Meta.Cosmetic."),
      entity,
      goldBars,
      gridIndex,
      tile: enumName(row.TileSize),
      expiration: enumName(row.ExpirationType),
      ...(expirationTime ? { expirationTime } : {}),
    });
  }
  return offers.sort((a, b) => a.id.localeCompare(b.id));
}

/** `WDChallengeDefinition` rows of the passive missions, by challenge tag. */
export function parsePassiveChallenges(exports: RawExport[]): Map<string, PassiveChallenge> {
  const out = new Map<string, PassiveChallenge>();
  for (const { key, row } of tableRows(exports, "WDChallengeDefinition")) {
    const objective = (row.Objectives ?? [])[0] as Props | undefined;
    const reward = (row.Rewards ?? [])[0] as Props | undefined;
    const objectiveTag = tagName(objective?.Key);
    const target = num(objective?.Value);
    const currency = tagName(reward?.RewardTag);
    const amount = num(reward?.Quantity);
    const name = text(row.DisplayName);
    if (!objectiveTag || target === undefined || !currency || amount === undefined || !name) continue;
    const description = text(row.Description);
    out.set(key, {
      id: strip(key, "Challenges.Challenge.Mission.Passive."),
      name,
      ...(description ? { description } : {}),
      objective: strip(objectiveTag, "Challenges.Objective."),
      target,
      reward: { currency: strip(currency, "Attribute.Meta.Currency."), amount },
    });
  }
  return out;
}

/** `WDMissionDefinition`: the passive missions with their tiers joined from the challenge table. A tier the table lacks is a thrown error. */
export function parsePassiveMissions(exports: RawExport[], challenges: Map<string, PassiveChallenge>): PassiveMission[] {
  const missions: PassiveMission[] = [];
  for (const { key, row } of tableRows(exports, "WDMissionDefinition")) {
    const tiers = ((row.Challenges ?? []) as Props[]).flatMap((c) => {
      const tag = tagName(c);
      if (!tag) return [];
      const challenge = challenges.get(tag);
      if (!challenge) throw new Error(`mission ${key} lists challenge ${tag}, which the challenge table does not define`);
      return [challenge];
    });
    missions.push({ id: strip(key, "Mission.Passive."), difficultyWeight: num(row.DifficultyWeight) ?? 0, challenges: tiers });
  }
  return missions.sort((a, b) => a.id.localeCompare(b.id));
}

/** What the challenge table holds about each achievement, by achievement tag: the description and the condition's numbers. */
export function parseAchievementChallenges(exports: RawExport[]): Map<string, { description?: string; thresholds?: Record<string, number> }> {
  const out = new Map<string, { description?: string; thresholds?: Record<string, number> }>();
  for (const { key, row } of tableRows(exports, "WDChallengeDefinition")) {
    if (!key.startsWith("Achievement.")) continue;
    const description = text(row.Description);
    const thresholds = decodeNumberBag(row.StateTreeReference?.Parameters ?? {});
    out.set(key, { ...(description ? { description } : {}), ...(Object.keys(thresholds).length ? { thresholds } : {}) });
  }
  return out;
}

/** `WDAchievementDefinition`: the Steam id and the name, with what the challenge table adds. */
export function parseAchievements(exports: RawExport[], challenges: ReturnType<typeof parseAchievementChallenges> = new Map()): Achievement[] {
  const out: Achievement[] = [];
  for (const { key, row } of tableRows(exports, "WDAchievementDefinition")) {
    const steamId = typeof row.SteamAchievementID === "string" ? row.SteamAchievementID : undefined;
    const name = text(row.DisplayName);
    if (steamId && name) out.push({ id: strip(key, "Achievement."), steamId, name, ...challenges.get(key) });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** The current season number from `WDMetaSeasonDefinitionTableRow`. */
export function parseCurrentSeason(exports: RawExport[]): number | undefined {
  for (const { row } of tableRows(exports, "WDMetaSeasonDefinitionTableRow")) {
    const n = num(row.CurrentSeasonNumber);
    if (n !== undefined) return n;
  }
  return undefined;
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

export interface MetaBuild {
  files: GeneratedFile[];
  notes: string[];
}

/** Builds `data/meta.json` from the raw cache, without touching the disk. A table that is missing fails the build. */
export function buildMetaData(rawDir: string, gameBuild: string): MetaBuild {
  const all = [...walk(join(rawDir, "items"))];
  const table = (name: string): RawExport[] => {
    const file = all.find((f) => f.endsWith(`${name}.json`) && /[\\/]DT_[^\\/]*$/.test(f));
    if (!file) throw new Error(`meta: the game's ${name} table is not in the cache; re-extract the items`);
    return read(file);
  };

  const { currencies } = parseCurrencies(table("DT_CurrenciesDefinitions"));
  const goldMarket = parseGoldMarket(table("DT_GoldMarket"));
  const passiveMissions = parsePassiveMissions(table("DT_PassiveMissions"), parsePassiveChallenges(table("DT_PassiveMissionChallenges")));
  const achievements = parseAchievements(table("DT_Achievements"), parseAchievementChallenges(table("DT_Challenges_SessionEvents_Shared")));
  const currentSeason = parseCurrentSeason(table("DT_SeasonDefinitions"));
  if (currentSeason === undefined) throw new Error("meta: DT_SeasonDefinitions has no current season number");

  const file = MetaFile.parse({ schemaVersion: 1, gameBuild, currencies, currentSeason, goldMarket, passiveMissions, achievements });
  return {
    files: [{ path: "data/meta.json", content: json(file) }],
    notes: [
      `meta: ${currencies.length} currencies, ${goldMarket.length} gold market offers, ${passiveMissions.length} passive missions with ${passiveMissions.reduce((n, m) => n + m.challenges.length, 0)} tiers, ${achievements.length} achievements, season ${currentSeason}`,
    ],
  };
}
