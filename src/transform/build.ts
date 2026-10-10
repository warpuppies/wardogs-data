import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ItemsFile } from "../schema.js";
import { buildItems, iconFilePath, mergeUiTables, parseItemDefinition, parseUiTable, parseUnlockTree, parseVendorTable, type RawExport } from "./items.js";

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

const readExports = (file: string): RawExport[] => JSON.parse(readFileSync(file, "utf8")) as RawExport[];

const isItemDefinitionFile = (f: string) => /[\\/]ID_[^\\/]*\.json$/.test(f);
const isUnlockTreeFile = (f: string) => /[\\/]DT_MetaTree_Roles\.json$/.test(f);

/** Vendor price tables: `DT_VendorData_*` (per feature) and `DT_*Market*` (global and per vehicle). */
const isVendorTableFile = (f: string) => /[\\/]DT_(VendorData_|[^\\/]*Market)[^\\/]*\.json$/.test(f);

/**
 * UI entity tables (`DT_EntityData*`): shared ones under `Content/` and per-feature ones under `Plugins/`. Items and
 * vehicles use `DT_EntityData_UI*`; attachments use `DT_EntityData_Ext_*`; music tapes use `DT_Ext_Entity_UI_*`. All
 * hold rows of the same struct.
 */
const isUiTableFile = (f: string) => /[\\/](DT_EntityData|DT_Ext_Entity_UI_)[^\\/]*\.json$/.test(f);

/** Feature plugins are more specific than the shared tables, so their rows win when an id is in both. */
const isPluginFile = (f: string) => /[\\/]Plugins[\\/]/.test(f);

/** Folder of the raw cache that holds the extracted icon PNGs (next to the decoded `items` folder). */
export const ICONS_DIR = "icons";

/** Merged display text for every id, from the UI tables in the cache. */
function loadUiText(rawDir: string, files: string[]) {
  const uiFiles = files.filter(isUiTableFile);
  return mergeUiTables(
    [...uiFiles.filter(isPluginFile), ...uiFiles.filter((f) => !isPluginFile(f))].map((f) => parseUiTable(readExports(f))),
  );
}

/** Game paths of the icon textures that the items use, sorted, for the extractor to export. */
export function itemIconTextures(rawDir: string): string[] {
  const { ui } = loadUiText(rawDir, [...walk(rawDir)]);
  return [...new Set([...ui.values()].flatMap((t) => (t.icon ? [t.icon] : [])))].sort();
}

export interface BuildSummary {
  items: number;
  priced: number;
  priceEntries: number;
  orphans: string[];
  unlocked: number;
  unlockOrphans: string[];
  /** Ids with UI text in more than one table, resolved by priority. */
  uiConflicts: string[];
  described: number;
  /** Items with an icon, and icon textures that were wanted but not extracted. */
  withIcon: number;
  missingIcons: string[];
}

export interface ItemsBuild {
  /** Serialized `items.json`. */
  content: string;
  summary: BuildSummary;
}

/**
 * Builds the items dataset from the raw decoded JSON cache, without touching the disk. `iconsDir` is where the icon
 * PNGs were extracted; an icon missing from it is left out and reported. With null, every icon is assumed present.
 */
export function buildItemsData(rawDir: string, gameBuild: string, iconsDir: string | null = null): ItemsBuild {
  const files = [...walk(rawDir)];
  const definitions = files
    .filter(isItemDefinitionFile)
    .map((f) => parseItemDefinition(readExports(f), relative(rawDir, f).split(sep).join("/").replace(/^Wardogs\//, "").replace(/\.json$/, "")))
    .filter((d) => d !== null);
  const vendor = files.filter(isVendorTableFile).flatMap((f) => parseVendorTable(readExports(f)));
  const unlocks = new Map(files.filter(isUnlockTreeFile).flatMap((f) => [...parseUnlockTree(readExports(f))]));

  const { ui, conflicts } = loadUiText(rawDir, files);
  const uiLower = new Map([...ui].map(([id, text]) => [id.toLowerCase(), text]));
  const uiText = (id: string) => uiLower.get(id.toLowerCase());

  const { items, orphans, unlockOrphans } = buildItems(definitions, vendor, unlocks, ui, (file) => iconsDir === null || existsSync(join(iconsDir, file)));
  const file = ItemsFile.parse({ schemaVersion: 1, gameBuild, items });
  return {
    content: JSON.stringify(file, null, 2) + "\n",
    summary: {
      items: items.length,
      priced: items.filter((i) => i.vendor.length > 0).length,
      priceEntries: items.reduce((n, i) => n + i.vendor.length, 0),
      orphans,
      unlocked: items.filter((i) => i.unlock !== null).length,
      unlockOrphans,
      uiConflicts: conflicts,
      described: items.filter((i) => i.description !== undefined).length,
      withIcon: items.filter((i) => i.icon !== undefined).length,
      missingIcons: [...new Set(definitions.flatMap((d) => (uiText(d.id)?.icon ? [iconFilePath(uiText(d.id)!.icon!)] : [])))]
        .filter((file) => iconsDir !== null && !existsSync(join(iconsDir, file)))
        .sort(),
    },
  };
}

/** Writes `items.json` into `dataDir`. Used by tests; the pipeline goes through `buildItemsData` and `apply`. */
export function buildItemsFile(rawDir: string, dataDir: string, gameBuild: string): BuildSummary {
  const { content, summary } = buildItemsData(rawDir, gameBuild);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "items.json"), content);
  return summary;
}
