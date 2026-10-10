import { buildDamageData } from "../transform/damage.js";
import type { Dataset } from "./types.js";

/**
 * The damage model. Its tables (`DT_GlobalDamage_*`, `DT_InfantryData_*`) are data tables, so the items extraction
 * already put them in the cache; this dataset only reads them.
 */
export const damageDataset: Dataset = {
  id: "damage",
  extract: () => undefined,
  async build(rawDir, meta) {
    return buildDamageData(rawDir, meta.gameBuild);
  },
};
