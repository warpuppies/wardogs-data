import { buildFeaturesData } from "../transform/features.js";
import type { Dataset } from "./types.js";

/**
 * Buildables and loot tables. Both come from assets the other extractions already put in the cache (buildable data
 * assets from `gameplay`, the build tool and lootable tables from `items`), so this dataset only reads them.
 */
export const featuresDataset: Dataset = {
  id: "features",
  extract: () => undefined,
  async build(rawDir, meta) {
    return buildFeaturesData(rawDir, meta.gameBuild);
  },
};
