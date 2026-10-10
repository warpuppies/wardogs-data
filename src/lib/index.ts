/**
 * The public helpers for people using the data from TypeScript. This file is the public API: every export below is
 * documented in the README and kept stable, and anything not exported here is internal. The helpers live on the `dev`
 * branch with the rest of the source. Everything here is pure except `loadWorld`, which reads files. Import from this file:
 *
 *   import { loadWorld, lineOfSight, ballisticArc, firstObstruction, valuePerSlot } from "./src/lib/index.js";
 */
export { ballisticArc, firstObstruction, lineOfSight, segmentBoxEntry } from "./lineOfSight.js";
export type { Box, HeightFn, Obstruction, PathOptions, Vec3 } from "./lineOfSight.js";
export { fitsSlot, itemsFittingSlot, tagMatches } from "./compatibility.js";
export type { FittingItem, SlotRules } from "./compatibility.js";
export { loadWorld, pixelToWorld, worldToPixel } from "./world.js";
export type { World } from "./world.js";
export { valuePerSlot } from "../analyze/valuePerSlot.js";
export type { SlotValue } from "../analyze/valuePerSlot.js";
export { ItemsFile, MapFile, BuildingsFile, TerrainFile } from "../schema.js";
export { AmmoFile, AttachmentsFile, DamageFile, EquipmentFile, ChallengeRewardsFile, RewardsFile, RolesFile, SkillsFile, VehiclesFile, WeaponsFile } from "../schema.gameplay.js";
