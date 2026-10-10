import { DEVELOPER_ITEMS, type Item, type Unlock, type Variation } from "../schema.js";

/** A localized text value as the extractor decodes it. */
interface RawText {
  LocalizedString?: string | null;
  SourceString?: string | null;
  CultureInvariantString?: string | null;
}

/** One decoded export from a package, as produced by the extractor. */
export interface RawExport {
  Type: string;
  Name?: string;
  Package?: string;
  Outer?: { ObjectName?: string };
  Properties?: Record<string, unknown>;
  Rows?: Record<string, VendorRow & UiRow>;
}

interface VendorRow {
  VendorItemVariations?: Array<{
    VariationTag?: { TagName?: string };
    Price?: number;
    Amount?: number;
    Categories?: string[];
  }>;
}

/**
 * `BHInventoryFragment_Stackable.MaxStackSize` default. The engine omits properties equal to the class
 * default, so a Stackable fragment with no value means this number. Verified against items whose stack
 * size is known (first aid kit = 2). If a game update changes the default, the canary tests fail.
 */
export const DEFAULT_MAX_STACK = 2;

interface Fragment {
  Dimensions?: { X: number; Y: number };
  MaxStackSize?: number;
  Weight?: number;
  ReplicatedData?: { Durability?: number };
}

type ItemBase = Omit<Item, "vendor" | "unlock">;

interface UiRow {
  Icons?: { FallbackIcon?: { AssetPathName?: string }; TaggedIcons?: Array<{ Key?: string; Value?: string[] }> };
  FriendlyName?: RawText;
  Description?: RawText;
  AdditionalTexts?: Array<{ Key?: { TagName?: string }; Value?: RawText }>;
}

/** Display text for one id, from the UI entity tables. Every field is optional. */
export interface UiText {
  /** Game path of the icon texture to show for the item (see `pickIcon`). */
  icon?: string;
  name?: string;
  subtitle?: string;
  description?: string;
}

/** Clean text for publishing: the game uses CRLF and pads some strings; empty means absent. */
const cleanText = (t: RawText | undefined): string | undefined => {
  const raw = t?.LocalizedString ?? t?.SourceString ?? t?.CultureInvariantString;
  const text = raw?.replace(/\r\n?/g, "\n").trim();
  return text ? text : undefined;
};

/**
 * Where the game uses an icon, most useful first. The inventory grid icon is what a player sees for the item; the
 * shop icon is the same picture in nearly every case. The row's fallback icon is often a killfeed silhouette, so it
 * only counts when nothing is tagged for the inventory or shop.
 */
export const ICON_USAGE_PRIORITY = [
  "UI.Icon.Inventory.Container",
  "UI.Icon.Vendor",
  "UI.Icon.Inventory.Equipment",
  "UI.Icon.Inventory.Pickup.Tooltip",
  "UI.Icon.Inventory.Tooltip",
  "UI.Icon.Default",
] as const;

/** Chooses the icon texture for a row, or undefined when it has none. */
export function pickIcon(icons: UiRow["Icons"]): string | undefined {
  for (const usage of ICON_USAGE_PRIORITY) {
    const tagged = icons?.TaggedIcons?.find((t) => t.Value?.includes(usage) && t.Key);
    if (tagged?.Key) return tagged.Key;
  }
  return icons?.FallbackIcon?.AssetPathName || undefined;
}

/**
 * File path of an icon inside the release's `icons/` folder: the package path without the leading `/Game/` or slash
 * and without the `.Name` suffix, plus `.png`. Folders keep apart textures that share a name (tracer ammo boxes).
 */
export function iconFilePath(texturePath: string): string {
  const pkg = texturePath.includes(".") ? texturePath.slice(0, texturePath.lastIndexOf(".")) : texturePath;
  return pkg.replace(/^\/+/, "").replace(/^Game\//i, "") + ".png";
}

const TOOLTIP_SUBTITLE = "UI.Tooltip.Layout.ItemSubtitle";
const TOOLTIP_DESCRIPTION = "UI.Tooltip.Layout.ItemDescription";

/**
 * Parses the UI entity tables (`DT_EntityData_UI*`): one row per item or vehicle id with its friendly name,
 * a short description, a tooltip subtitle and the icon textures. The tooltip flavor text (`ItemFlavor`) is deliberately not read:
 * it is prose written by the developer, not data. A row with no text at all is skipped.
 */
export function parseUiTable(exports: RawExport[]): Map<string, UiText> {
  const out = new Map<string, UiText>();
  for (const exp of exports) {
    if (exp.Type !== "DataTable" || !exp.Rows) continue;
    for (const [id, row] of Object.entries(exp.Rows)) {
      const extra = (tag: string) => cleanText(row.AdditionalTexts?.find((t) => t.Key?.TagName === tag)?.Value);
      const text: UiText = {};
      const icon = pickIcon(row.Icons);
      if (icon) text.icon = icon;
      const name = cleanText(row.FriendlyName);
      const subtitle = extra(TOOLTIP_SUBTITLE);
      const description = cleanText(row.Description) ?? extra(TOOLTIP_DESCRIPTION);
      if (name) text.name = name;
      if (subtitle) text.subtitle = subtitle;
      if (description) text.description = description;
      if (Object.keys(text).length) out.set(id, text);
    }
  }
  return out;
}

/** Parses one item-definition package (`ID_*`). Returns null for packages that are not item definitions. */
export function parseItemDefinition(exports: RawExport[], asset: string): ItemBase | null {
  const main = exports.find((e) => e.Type === "BHInventoryItemDefinition");
  if (!main) return null;
  const props = (main.Properties ?? {}) as {
    ItemId?: { TagName?: string };
    ItemContext?: string[];
    DisplayName?: { LocalizedString?: string; SourceString?: string };
  };
  const id = props.ItemId?.TagName;
  if (!id) return null;

  const item: ItemBase = {
    id,
    kind: id.startsWith("Vehicle.") ? "vehicle" : "item",
    asset,
    name: cleanText(props.DisplayName) ?? id,
    tags: props.ItemContext ?? [],
    grid: [1, 1],
    maxStack: 1,
  };

  for (const exp of exports) {
    const p = (exp.Properties ?? {}) as Fragment;
    switch (exp.Type) {
      case "BHInventoryFragment_CustomShape":
        if (p.Dimensions) item.grid = [p.Dimensions.X, p.Dimensions.Y];
        break;
      case "BHInventoryFragment_Stackable":
        item.maxStack = p.MaxStackSize ?? DEFAULT_MAX_STACK;
        break;
      case "BHInventoryFragment_Weight":
        if (p.Weight !== undefined) item.weight = p.Weight;
        break;
      case "WDInventoryFragment_Durability":
        if (p.ReplicatedData?.Durability !== undefined) item.durability = p.ReplicatedData.Durability;
        break;
    }
  }
  return item;
}

export interface VendorEntry {
  /** Row key in the table: the base item id (or an `Id.Item.X.Variant` form). */
  rowId: string;
  variation: Variation;
}

/** Parses a vendor DataTable export into flat entries. */
export function parseVendorTable(exports: RawExport[]): VendorEntry[] {
  const out: VendorEntry[] = [];
  for (const exp of exports) {
    if (exp.Type !== "DataTable" || !exp.Rows) continue;
    for (const [rowId, row] of Object.entries(exp.Rows)) {
      for (const v of row.VendorItemVariations ?? []) {
        if (typeof v.Price !== "number") continue;
        out.push({
          rowId,
          variation: {
            tag: v.VariationTag?.TagName ?? rowId,
            price: v.Price,
            amount: v.Amount ?? 1,
            categories: v.Categories ?? [],
          },
        });
      }
    }
  }
  return out;
}

interface TreeNode {
  ID?: { TagName?: string };
  LevelsData?: Array<{
    Prerequisites?: { QueryDefinition?: { SharedDefinition?: { Conditions?: { Structs?: Array<{ MinLevel?: number; MetaId?: { TagName?: string } }> } } } };
    Cost?: Array<{ Key?: { TagName?: string }; Value?: number }>;
  }>;
}

const CASH_TAG = "Attribute.Meta.Currency.Cash";

/**
 * Parses the progression trees (`DT_MetaTree_Roles`): one row per tree, each listing the items and vehicles it
 * unlocks with a minimum level and a cash cost. Per-role trees name the role in the condition; the tree
 * `Meta.Role.Wardog` has no role in its conditions and is the account-wide career level.
 * The vendor tables' `LevelToUnlock` is NOT the unlock level (it is only ever 0 or 1), so it is not used.
 */
export function parseUnlockTree(exports: RawExport[]): Map<string, Unlock> {
  const unlocks = new Map<string, Unlock>();
  for (const exp of exports) {
    if (exp.Type !== "DataTable" || !exp.Rows) continue;
    for (const [treeTag, row] of Object.entries(exp.Rows) as Array<[string, { Nodes?: TreeNode[] }]>) {
      const role = treeTag.split(".").pop() ?? treeTag;
      for (const node of row.Nodes ?? []) {
        const id = node.ID?.TagName;
        const level = node.LevelsData?.[0];
        if (!id || !level) continue;
        const minLevel = level.Prerequisites?.QueryDefinition?.SharedDefinition?.Conditions?.Structs?.[0]?.MinLevel;
        if (typeof minLevel !== "number" || minLevel < 1) continue;
        const cost = level.Cost?.find((c) => c.Key?.TagName === CASH_TAG)?.Value ?? 0;
        unlocks.set(id, { role, level: minLevel, cost });
      }
    }
  }
  return unlocks;
}

/**
 * Combines UI tables given in priority order. The first table that has an id wins. A lower row with the same name
 * describes the same thing, so it only fills in fields the winner lacks (a feature table often has the icon and the
 * shared one the description). A lower row with a different name is never mixed in, as that would give a name from
 * one and a description from another. Ids whose rows disagree are returned so the build can report them. Ids are
 * compared without regard to case, as the game's tags are (`Id.Item.X` and `ID.Item.X` are one id); the result keeps
 * the casing of the first table that has the id.
 */
export function mergeUiTables(tables: ReadonlyArray<ReadonlyMap<string, UiText>>): { ui: Map<string, UiText>; conflicts: string[] } {
  const ui = new Map<string, UiText>();
  const conflicts = new Set<string>();
  const sameName = (a: UiText, b: UiText) => a.name !== undefined && a.name.toLowerCase() === b.name?.toLowerCase();
  const canonical = new Map<string, string>(); // lower-case id -> the id as first seen
  for (const table of tables) {
    for (const [rawId, text] of table) {
      const id = canonical.get(rawId.toLowerCase()) ?? rawId;
      canonical.set(id.toLowerCase(), id);
      const seen = ui.get(id);
      if (!seen) {
        ui.set(id, { ...text });
        continue;
      }
      const same = sameName(seen, text);
      for (const key of ["icon", "subtitle", "description"] as const) {
        if (text[key] === undefined) continue;
        if (seen[key] === undefined && same) seen[key] = text[key];
        else if (seen[key] !== text[key]) conflicts.add(id);
      }
      if (!same) conflicts.add(id);
    }
  }
  return { ui, conflicts: [...conflicts].sort() };
}

export interface BuildResult {
  items: Item[];
  /** Vendor entries whose base item definition could not be found. */
  orphans: string[];
  /** Unlock-tree ids with no matching item definition. */
  unlockOrphans: string[];
}

const byLowerCase = <T>(map: ReadonlyMap<string, T>): Map<string, T> => new Map([...map].map(([id, value]) => [id.toLowerCase(), value]));

/**
 * Joins item definitions with vendor prices, unlocks and UI text. Ids match without regard to case, as the game's tags
 * do: the unlock tree says `Id.Item.MedKit.Standard` for the definition `ID.Item.MedKit.Standard`. The output keeps
 * the definition's casing and is sorted so diffs stay small and stable.
 */
export function buildItems(
  definitions: ItemBase[],
  vendorEntries: VendorEntry[],
  unlocks: ReadonlyMap<string, Unlock> = new Map(),
  ui: ReadonlyMap<string, UiText> = new Map(),
  /** Whether the icon file (see `iconFilePath`) was extracted. An icon that was not is left out. */
  hasIcon: (file: string) => boolean = () => true,
): BuildResult {
  const byId = new Map<string, Item>();
  const unlocksByLower = byLowerCase(unlocks);
  const uiByLower = byLowerCase(ui);
  for (const def of definitions) {
    const text = uiByLower.get(def.id.toLowerCase());
    const item: Item = { ...def, unlock: unlocksByLower.get(def.id.toLowerCase()) ?? null, vendor: [] };
    if (def.id in DEVELOPER_ITEMS) item.developer = true;
    // A definition without its own DisplayName was given the id as name; the UI table has the real one.
    if (item.name === item.id && text?.name) item.name = text.name;
    if (text?.icon && hasIcon(iconFilePath(text.icon))) item.icon = iconFilePath(text.icon);
    if (text?.subtitle) item.subtitle = text.subtitle;
    if (text?.description) item.description = text.description;
    byId.set(def.id, item);
  }
  const itemsByLower = byLowerCase(byId);

  const seen = new Set<string>();
  const orphans: string[] = [];
  for (const { rowId, variation } of vendorEntries) {
    const base = itemsByLower.get(rowId.toLowerCase()) ?? itemsByLower.get(rowId.slice(0, Math.max(0, rowId.lastIndexOf("."))).toLowerCase());
    if (!base) {
      orphans.push(rowId);
      continue;
    }
    const key = [base.id, variation.tag, variation.price, variation.amount].join("|");
    if (seen.has(key)) continue; // the same entry is listed in more than one vendor table
    seen.add(key);
    base.vendor.push(variation);
  }

  const items = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const item of items) item.vendor.sort((a, b) => a.tag.localeCompare(b.tag) || a.price - b.price);
  const unlockOrphans = [...unlocks.keys()].filter((id) => !itemsByLower.has(id.toLowerCase())).sort();
  return { items, orphans: [...new Set(orphans)].sort(), unlockOrphans };
}
