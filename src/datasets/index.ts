import type { Dataset } from "./types.js";
import { damageDataset } from "./damage.js";
import { featuresDataset } from "./features.js";
import { gameplayDataset } from "./gameplay.js";
import { itemsDataset } from "./items.js";
import { mapsDataset } from "./maps.js";
import { metaDataset } from "./meta.js";
import { movementDataset } from "./movement.js";
import { objectivesDataset } from "./objectives.js";
import { progressionDataset } from "./progression.js";
import { worldObjectsDataset } from "./worldObjects.js";

/** Every dataset the pipeline owns. Adding one here, with tests, is how the repo grows. */
export const DATASETS: readonly Dataset[] = [itemsDataset, gameplayDataset, damageDataset, progressionDataset, metaDataset, featuresDataset, movementDataset, mapsDataset, objectivesDataset, worldObjectsDataset];
