import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const CacheMeta = z.object({ gameBuild: z.string(), cue4parse: z.string() });
export type CacheMeta = z.infer<typeof CacheMeta>;

const META_FILE = "_meta.json";

/** Records what the cache was extracted from, so building from the cache needs no game install. */
export function writeCacheMeta(rawDir: string, meta: CacheMeta): void {
  mkdirSync(rawDir, { recursive: true });
  writeFileSync(join(rawDir, META_FILE), JSON.stringify(meta, null, 2) + "\n");
}

export function readCacheMeta(rawDir: string): CacheMeta {
  const file = join(rawDir, META_FILE);
  if (!existsSync(file)) throw new Error("The extraction cache is empty. Run `pnpm extract` first.");
  return CacheMeta.parse(JSON.parse(readFileSync(file, "utf8")));
}
