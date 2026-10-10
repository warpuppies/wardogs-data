import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { exportActors } from "../extract/run.js";
import { buildWorldObjects, OBJECT_CLASS_PATTERN } from "../maps/worldObjects.js";
import { WORLDS } from "../maps/worlds.js";
import type { Dataset } from "./types.js";

const file = (rawDir: string, id: string) => join(rawDir, "objects", `${id}.actors.jsonl`);

/** Gameplay objects placed in each world (shops, safe zones, spawns). Extraction reads every level of a world: several minutes each. */
export const worldObjectsDataset: Dataset = {
  id: "objects",
  extract(config) {
    for (const w of WORLDS) {
      console.log(`scanning ${w.id} (several minutes)`);
      exportActors(config, `Wardogs/Content/Maps/Worlds/${w.folder}/`, OBJECT_CLASS_PATTERN, file(config.rawDir, w.id));
    }
  },
  async build(rawDir, meta) {
    const files = [];
    const notes: string[] = [];
    for (const w of WORLDS) {
      const source = file(rawDir, w.id);
      if (!existsSync(source)) throw new Error(`The object scan of ${w.id} is not in the cache. Run \`pnpm extract objects\` first.`);
      const built = buildWorldObjects(w, readFileSync(source, "utf8"), meta.gameBuild);
      files.push(built.file);
      notes.push(`objects ${w.id}: ${Object.entries(built.counts).map(([k, n]) => `${n} ${k}`).join(", ") || "none"}${built.skipped ? ` (${built.skipped} lines skipped)` : ""}`);
    }
    return { files, notes };
  },
};
