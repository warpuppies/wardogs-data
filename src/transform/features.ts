import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GeneratedFile } from "../generated.js";
import { BuildablesFile, CosmeticsFile, LootFile, TagsFile, type Buildable, type Cosmetic, type CosmeticSet, type LootTable, type TagText } from "../schema.gameplay.js";
import type { RawExport } from "./items.js";
import { ICONS_DIR } from "./build.js";
import { PackageIndex } from "./packages.js";
import { readUiIcons } from "./uiIcons.js";

type Props = Record<string, any>; // decoded game properties: shapes are checked field by field below

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const tag = (v: unknown): string | undefined => {
  const name = (v as { TagName?: unknown } | undefined)?.TagName;
  return typeof name === "string" && name !== "None" ? name : undefined;
};
const strip = (value: string, prefix: string): string => (value.startsWith(prefix) ? value.slice(prefix.length) : value);
const text = (v: unknown): string | undefined => {
  const t = v as { LocalizedString?: string | null; SourceString?: string | null; CultureInvariantString?: string | null } | undefined;
  return (t?.LocalizedString ?? t?.SourceString ?? t?.CultureInvariantString)?.replace(/\r\n?/g, "\n").trim() || undefined;
};
const compact = <T extends object>(obj: T): T => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
const roundMeters = (cm: number): number => Math.round(cm) / 100;

/** `BlueprintGeneratedClass'B_SafeZonePlacementCondition_C'` becomes `SafeZone`; `Class'WDWithinFobBoundsPlacementCondition'` becomes `WithinFobBounds`. */
export function conditionName(objectName: unknown): string | undefined {
  const match = typeof objectName === "string" ? /'(.+?)'$/.exec(objectName) : null;
  if (!match) return undefined;
  return match[1]!.replace(/_C$/, "").replace(/^(?:B_|WD)/, "").replace(/PlacementCondition$/, "");
}

/** Parses a buildable data asset (`WDBuildableDataAsset`). The tools that offer it are filled in by the caller. */
export function parseBuildable(exp: RawExport): Buildable | null {
  const p = (exp.Properties ?? {}) as Props;
  const id = tag(p.EntityTag);
  const cost = num(p.Cost);
  const maxHealth = num(p.MaxHealth);
  if (!id || cost === undefined || maxHealth === undefined || maxHealth <= 0) return null;
  const box = p.FinalStageBoundingBox as Props | undefined;
  const size =
    box?.Min && box?.Max && box.IsValid !== 0
      ? ([roundMeters((num(box.Max.X) ?? 0) - (num(box.Min.X) ?? 0)), roundMeters((num(box.Max.Y) ?? 0) - (num(box.Min.Y) ?? 0)), roundMeters((num(box.Max.Z) ?? 0) - (num(box.Min.Z) ?? 0))] as [number, number, number])
      : undefined;
  const damageTag = tag(p.DamageEntityData?.Tag);
  const rules = ((p.PlacementConditions ?? []) as Props[]).map((c) => conditionName(c.ObjectName)).filter((n): n is string => n !== undefined);
  return compact({
    id,
    name: text(p.DisplayName),
    cost,
    maxHealth,
    repairSpeedMultiplier: num(p.RepairSpeedMultiplier),
    maxStack: (num(p.MaxStack) ?? 0) > 0 ? num(p.MaxStack) : undefined, // 0 in the game means the buildable does not stack
    damageEntity: damageTag ? strip(damageTag, "Meta.Damage.") : undefined,
    size,
    tools: [],
    placementRules: rules,
  }) as Buildable;
}

/** Parses a build tool's table (`WDBuildableDataTableRow`): the buildable ids it offers. */
export function parseToolBuildables(exports: RawExport[]): string[] {
  const ids: string[] = [];
  for (const exp of exports) {
    if (exp.Type !== "DataTable" || !exp.Rows) continue;
    for (const [key, row] of Object.entries(exp.Rows) as Array<[string, Props]>) ids.push(tag(row.Tag) ?? key);
  }
  return ids;
}

/** Parses the lootable table (`WDLootableDataTable`): one row per loot table, with the items it can spawn. */
export function parseLootTables(exports: RawExport[]): LootTable[] {
  const tables: LootTable[] = [];
  for (const exp of exports) {
    if (exp.Type !== "DataTable" || !exp.Rows) continue;
    if (!String(((exp.Properties ?? {}) as Props).RowStruct?.ObjectName ?? "").includes("WDLootableDataTable")) continue;
    for (const [key, row] of Object.entries(exp.Rows) as Array<[string, Props]>) {
      const data = (row.LootableData ?? {}) as Props;
      const items = ((data.ItemsToSpawn ?? []) as Props[]).flatMap((entry) => {
        const item = tag(entry.ItemTag);
        if (!item) return [];
        const subItems = ((entry.SubItemsSpawnData ?? []) as Props[]).flatMap((s) => {
          const sub = tag(s.SubItemTag);
          return sub ? [{ item: sub, chance: num(s.SubSpawnChance) ?? 100, amount: num(s.SubItemAmount) ?? 1 }] : [];
        });
        return [{ item, amount: num(entry.ItemAmount) ?? 1, weight: num(entry.ItemSpawnWeight) ?? 1, subItems }];
      });
      tables.push(
        compact({
          id: strip(key, "Lootable."),
          spawnChance: num(data.SpawnChance) ?? 100,
          spawnByDefault: bool(data.bSpawnByDefault),
          spawnByPoints: bool(data.bSpawnByPoints),
          initialSpawnTime: num(data.InitialSpawnTime),
          initialSpawnPoints: num(data.InitialSpawnPoints),
          canRespawn: bool(data.bCanRespawn),
          respawnTime: num(data.RespawnTime),
          neverSelectPreviousItem: bool(data.bNeverSelectPreviousItem),
          spawnInsideControlZoneOnly: bool(row.bSpawnInsideControlZoneOnly),
          items,
        }) as LootTable,
      );
    }
  }
  return tables;
}

const tableStruct = (exp: RawExport): string => String(((exp.Properties ?? {}) as Props).RowStruct?.ObjectName ?? "");

/** Parses a cosmetics table (`WDCosmeticData`): one row per cosmetic. `source` is the table's name without its `DT_Cosmetics_` prefix. */
export function parseCosmetics(source: string, exports: RawExport[]): Cosmetic[] {
  const out: Cosmetic[] = [];
  for (const exp of exports) {
    if (exp.Type !== "DataTable" || !exp.Rows || !tableStruct(exp).includes("WDCosmeticData")) continue;
    for (const [key, row] of Object.entries(exp.Rows) as Array<[string, Props]>) {
      const item = tag(row.EntityID);
      const set = tag(row.Category);
      if (!item || !set) continue;
      const archetype = tag(row.Archetype);
      out.push(compact({ id: strip(key, "Meta.Cosmetic."), item, set: strip(set, "Meta.Cosmetic."), archetype: archetype ? strip(archetype, "Item.Archetype.") : undefined, source }) as Cosmetic);
    }
  }
  return out;
}

/** Parses the cosmetic set table (`WDCosmeticSetData`): named groups with their order in the collection. */
export function parseCosmeticSets(exports: RawExport[]): CosmeticSet[] {
  const out: CosmeticSet[] = [];
  for (const exp of exports) {
    if (exp.Type !== "DataTable" || !exp.Rows || !tableStruct(exp).includes("WDCosmeticSetData")) continue;
    for (const [key, row] of Object.entries(exp.Rows) as Array<[string, Props]>) {
      const name = text(row.Name);
      if (name) out.push({ id: strip(key, "Meta.Cosmetic."), name, sortIndex: Math.trunc(num(row.SortIndex) ?? 0), hidden: bool(row.bHideInCollection) ?? false });
    }
  }
  return out.sort((a, b) => a.sortIndex - b.sortIndex || a.id.localeCompare(b.id));
}

/** Parses a tag text table (`WDUIGameplayTagToTextTableRow`). `source` is the table's name without its `DT_GameplayTagToText_` prefix. Rows with no text are skipped. */
export function parseTagTexts(source: string, exports: RawExport[]): TagText[] {
  const out: TagText[] = [];
  for (const exp of exports) {
    if (exp.Type !== "DataTable" || !exp.Rows || !tableStruct(exp).includes("WDUIGameplayTagToTextTableRow")) continue;
    for (const [key, row] of Object.entries(exp.Rows) as Array<[string, Props]>) {
      const t = text(row.Text);
      if (t) out.push({ tag: tag(row.Tag) ?? key, text: t, source });
    }
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

const read = (file: string): RawExport[] => JSON.parse(readFileSync(file, "utf8")) as RawExport[];
const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";

export interface FeaturesBuild {
  files: GeneratedFile[];
  notes: string[];
}

/** Builds `data/buildables.json`, `data/loot.json`, `data/cosmetics.json` and `data/tags.json` from the raw cache, without touching the disk. */
export function buildFeaturesData(rawDir: string, gameBuild: string): FeaturesBuild {
  const itemsDir = join(rawDir, "items");
  const index = new PackageIndex([itemsDir, join(rawDir, "gameplay")]);
  const all = [...walk(itemsDir)];

  const buildables = new Map<string, Buildable>();
  for (const { export: exp } of index.findAll("WDBuildableDataAsset", "DA_Buildable_")) {
    const parsed = parseBuildable(exp);
    if (parsed) buildables.set(parsed.id, parsed);
  }
  const toolOnly = new Set<string>();
  for (const file of all.filter((f) => /[\\/]DT_Buildables_[A-Za-z]+Hammer\.json$/.test(f))) {
    const tool = /DT_Buildables_([A-Za-z]+)\.json$/.exec(file)![1]!;
    for (const id of parseToolBuildables(read(file))) {
      const buildable = buildables.get(id);
      if (buildable) buildable.tools.push(tool);
      else toolOnly.add(id);
    }
  }
  const uiIcons = readUiIcons(itemsDir, join(rawDir, ICONS_DIR));
  const buildableList = [...buildables.values()]
    .map((b) => ({ ...b, ...(uiIcons.get(b.id.toLowerCase())?.icon ? { icon: uiIcons.get(b.id.toLowerCase())!.icon } : {}), tools: [...new Set(b.tools)].sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const loot = all
    .filter((f) => /[\\/]DT_LootableDataTable\.json$/.test(f))
    .flatMap((f) => parseLootTables(read(f)))
    .sort((a, b) => a.id.localeCompare(b.id));

  const cosmetics = all
    .filter((f) => /[\\/]DT_Cosmetics_[^\\/]*\.json$/.test(f))
    .flatMap((f) => parseCosmetics(/DT_Cosmetics_([^\\/]*)\.json$/.exec(f)![1]!, read(f)))
    .sort((a, b) => a.id.localeCompare(b.id) || a.source.localeCompare(b.source));
  const sets = all.filter((f) => /[\\/]DT_CosmeticSets_[^\\/]*\.json$/.test(f)).flatMap((f) => parseCosmeticSets(read(f)));

  const tags = all
    .filter((f) => /[\\/]DT_GameplayTagToText_[^\\/]*\.json$/.test(f))
    .flatMap((f) => parseTagTexts(/DT_GameplayTagToText_([^\\/]*)\.json$/.exec(f)![1]!, read(f)))
    .sort((a, b) => a.tag.localeCompare(b.tag) || a.source.localeCompare(b.source));

  const header = { schemaVersion: 1 as const, gameBuild };
  return {
    files: [
      { path: "data/tags.json", content: json(TagsFile.parse({ ...header, tags })) },
      { path: "data/cosmetics.json", content: json(CosmeticsFile.parse({ ...header, sets, cosmetics })) },
      { path: "data/buildables.json", content: json(BuildablesFile.parse({ ...header, units: "meters", buildables: buildableList })) },
      { path: "data/loot.json", content: json(LootFile.parse({ ...header, tables: loot })) },
    ],
    notes: [
      `buildables: ${buildableList.length} (${buildableList.filter((b) => b.tools.length).length} offered by a build tool, ${buildableList.filter((b) => b.icon).length} with an icon)`,
      ...(toolOnly.size ? [`note: ${toolOnly.size} build tool rows name a buildable with no data asset and are not published: ${[...toolOnly].sort().join(", ")}`] : []),
      `loot: ${loot.length} tables, ${loot.reduce((n, t) => n + t.items.length, 0)} entries`,
      `cosmetics: ${cosmetics.length} in ${sets.length} sets`,
      `tags: ${tags.length} with text from ${new Set(tags.map((t) => t.source)).size} tables`,
    ],
  };
}
