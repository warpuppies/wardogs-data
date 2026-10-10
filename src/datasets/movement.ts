import { buildMovementData } from "../transform/movement.js";
import type { Dataset } from "./types.js";

/** Player movement tuning. It comes from data assets and curves that the gameplay extraction already put in the cache. */
export const movementDataset: Dataset = {
  id: "movement",
  extract: () => undefined,
  async build(rawDir, meta) {
    return buildMovementData(rawDir, meta.gameBuild);
  },
};
