import { join } from "node:path";
import { extractLinkedPackages } from "../extract/linked.js";
import { exportJson } from "../extract/run.js";
import { buildGameplayData } from "../transform/gameplay.js";
import type { Dataset } from "./types.js";

/**
 * Data assets (`DA_*`: weapon stats, projectiles, vehicle stats), gameplay effects (`GE_*`: attachment modifiers),
 * curve tables (`CT_*`: the value of each skill level) and curves (`CRV_*`, `CF_*`, `FC_*` and anything in a `Curves` folder: the fall damage curve, vehicle torque and helicopter flight curves), plus the player movement settings blueprint (`MoverTesting/Settings/B_*`: stamina regeneration).
 */
const INCLUDE = String.raw`/(DA|GE|CT|CRV|CF|FC)_[^/]*\.uasset$|/Curves/[^/]*\.uasset$|/MoverTesting/Settings/B_[^/]*\.uasset$`;
const EXCLUDE = String.raw`/(Animation|Audio|VFX|Megascans|Environment|Movies)/`;

export const gameplayDataset: Dataset = {
  id: "gameplay",
  async extract(config, ctx) {
    const dir = join(config.rawDir, "gameplay");
    await exportJson(config, INCLUDE, EXCLUDE, dir);
    // The vehicle configs link to assets the name patterns miss (input mappings, audio data, flight curves). They are
    // looked up among the items too, so the items have to be there.
    await ctx.after("items");
    await extractLinkedPackages(config, dir, join(config.rawDir, "items"));
  },
  async build(rawDir, meta) {
    const { files, notes } = buildGameplayData(rawDir, meta.gameBuild);
    return { files, notes };
  },
};
