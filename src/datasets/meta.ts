import { buildMetaData } from "../transform/meta.js";
import type { Dataset } from "./types.js";

/** Currencies, the gold market, passive missions and achievements. They are data tables that the items extraction already put in the cache. */
export const metaDataset: Dataset = {
  id: "meta",
  extract: () => undefined,
  async build(rawDir, meta) {
    return buildMetaData(rawDir, meta.gameBuild);
  },
};
