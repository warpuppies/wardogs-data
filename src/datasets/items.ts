import { join } from "node:path";
import { exportJson, exportTextures } from "../extract/run.js";
import { buildItemsData, ICONS_DIR, itemIconTextures } from "../transform/build.js";
import type { Dataset } from "./types.js";

/** Item definitions (`ID_*`) and data tables (`DT_*`), minus asset folders that hold no game data. */
const INCLUDE = String.raw`/(ID|DT)_[^/]*\.uasset$`;
const EXCLUDE = String.raw`/(Animation|Audio|VFX|Megascans|Environment|Maps|Movies|Characters)/`;

export const itemsDataset: Dataset = {
  id: "items",
  extract(config) {
    const itemsDir = join(config.rawDir, "items");
    exportJson(config, INCLUDE, EXCLUDE, itemsDir);
    // The icons to export are named by the tables just decoded, so this has to come second.
    exportTextures(config, itemIconTextures(itemsDir), join(config.rawDir, "icons.list.json"), join(config.rawDir, ICONS_DIR));
  },
  async build(rawDir, meta) {
    const { content, summary } = buildItemsData(join(rawDir, "items"), meta.gameBuild, join(rawDir, ICONS_DIR));
    const notes = [`items: ${summary.items} definitions, ${summary.priced} priced (${summary.priceEntries} price entries), ${summary.unlocked} with unlocks, ${summary.described} with descriptions, ${summary.withIcon} with icons`];
    if (summary.missingIcons.length) notes.push(`warning: ${summary.missingIcons.length} icons were not extracted: ${summary.missingIcons.slice(0, 5).join(", ")}`);
    if (summary.uiConflicts.length) notes.push(`note: ${summary.uiConflicts.length} ids have different UI text in more than one table (feature tables win): ${summary.uiConflicts.join(", ")}`);
    if (summary.orphans.length) notes.push(`warning: ${summary.orphans.length} vendor entries had no item definition: ${summary.orphans.slice(0, 5).join(", ")}`);
    if (summary.unlockOrphans.length) notes.push(`warning: ${summary.unlockOrphans.length} unlock-tree ids had no item definition: ${summary.unlockOrphans.slice(0, 5).join(", ")}`);
    return { files: [{ path: "data/items.json", content }], notes };
  },
};
