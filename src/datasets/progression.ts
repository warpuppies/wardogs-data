import { buildProgressionData } from "../transform/progression.js";
import type { Dataset } from "./types.js";

/**
 * Role skills and cash rewards. The skill and reward tables are data tables, which the items extraction already put in
 * the cache, and the skill curves are curve tables from the gameplay extraction; this dataset only reads them.
 */
export const progressionDataset: Dataset = {
  id: "progression",
  extract: () => undefined,
  async build(rawDir, meta) {
    return buildProgressionData(rawDir, meta.gameBuild);
  },
};
