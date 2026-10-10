import { join } from "node:path";
import { buildObjectives } from "../maps/objectives.js";
import { WORLDS } from "../maps/worlds.js";
import { PackageIndex } from "../transform/packages.js";
import type { Dataset } from "./types.js";

/**
 * Match objectives (control zones). The configuration assets are data assets, which the gameplay extraction already put
 * in the cache; this dataset only reads them.
 */
export const objectivesDataset: Dataset = {
  id: "objectives",
  extract: () => undefined,
  async build(rawDir, meta) {
    const index = new PackageIndex([join(rawDir, "gameplay")]);
    const sources = [...index.findAll("WDControlZoneConfigDataAsset", "DA_")].map((r) => ({ name: r.asset.split("/").pop()!, export: r.export }));
    const { files, unplaced } = buildObjectives(sources, WORLDS, meta.gameBuild);
    const notes = [`objectives: ${files.length} worlds with control zones`];
    if (unplaced.length) notes.push(`note: ${unplaced.length} control zone configs belong to no world and are not published: ${unplaced.join(", ")}`);
    return { files, notes };
  },
};
