import { buildSettingsData } from "../transform/settings.js";
import type { Dataset } from "./types.js";

export const settingsDataset: Dataset = {
  id: "settings",
  extract: () => undefined,
  async build(rawDir, meta) {
    return buildSettingsData(rawDir, meta.gameBuild);
  },
};
