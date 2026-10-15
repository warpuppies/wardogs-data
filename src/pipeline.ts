import { copyFileSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readCacheMeta, writeCacheMeta } from "./cache.js";
import type { Config } from "./config.js";
import { DATASETS } from "./datasets/index.js";
import type { ExtractContext } from "./datasets/types.js";
import { deriveFiles } from "./derived/index.js";
import { applyFiles, planFiles, walk, type GeneratedFile, type PlanEntry } from "./generated.js";
import { buildManifest, verifyManifest, type VerifyResult } from "./manifest.js";
import { readGameBuild } from "./extract/steam.js";
import { copyIcons, iconReferences } from "./icons.js";
import { CURRENT_TILING, reusableWorld } from "./release.js";
import { buildTiles, hashFile } from "./maps/tiles.js";
import { ICONS_DIR } from "./transform/build.js";
import { WORLDS } from "./maps/worlds.js";

/** Directories the pipeline owns. Anything in them that it does not produce is stale and gets removed by `apply`. */
export const OWNED_DIRS = ["data"] as const;

export const readCue4ParseRevision = (): string => readFileSync(join("extractor", "CUE4PARSE_REVISION"), "utf8").trim();

/** Every file under `data/`, relative to the repo root. */
export const listDataFiles = (root: string): string[] => [...walk(join(root, "data"), root)];

/** Extracts raw facts from the install into the cache and records what they came from. */
export async function extractAll(config: Config, only?: string): Promise<void> {
  const selected = DATASETS.filter((d) => !only || d.id === only);
  if (selected.length === 0) throw new Error(`Unknown dataset "${only}". Known: ${DATASETS.map((d) => d.id).join(", ")}`);
  // The datasets extract at the same time; one that needs another's files waits for it.
  const running = new Map<string, Promise<void>>();
  const ctx: ExtractContext = { after: (id) => running.get(id) ?? Promise.resolve() };
  for (const dataset of selected) {
    console.log(`extracting ${dataset.id}`);
    running.set(dataset.id, Promise.resolve().then(() => dataset.extract(config, ctx)));
  }
  // Every extraction is waited for, so none is left running when one fails.
  const results = await Promise.allSettled(running.values());
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
  writeCacheMeta(config.rawDir, { gameBuild: readGameBuild(config.installDir), cue4parse: readCue4ParseRevision() });
}

export interface Built {
  files: GeneratedFile[];
  notes: string[];
}

/** Derives every generated file, and the manifest, from the cache. Pure: needs no game install. */
export async function buildAll(rawDir: string): Promise<Built> {
  const meta = readCacheMeta(rawDir);
  const files: GeneratedFile[] = [];
  const notes: string[] = [];
  // The builds read the cache and nothing else, so they run together (the ones that wait on image decoding overlap the rest);
  // their files and notes are joined in the order of the datasets.
  for (const out of await Promise.all(DATASETS.map((dataset) => dataset.build(rawDir, meta)))) {
    files.push(...out.files);
    notes.push(...out.notes);
  }
  const all = [...files, ...deriveFiles(files)];
  return { files: [...all, buildManifest(all, meta)], notes };
}

/** What `apply` would do. Writes nothing. */
export async function plan(root: string, rawDir: string): Promise<{ entries: PlanEntry[]; built: Built }> {
  const built = await buildAll(rawDir);
  return { entries: planFiles(root, built.files, OWNED_DIRS), built };
}

/** Writes every generated file and the manifest, and removes stale outputs. Idempotent. */
export async function apply(root: string, rawDir: string): Promise<{ entries: PlanEntry[]; built: Built }> {
  const result = await plan(root, rawDir);
  applyFiles(root, result.built.files, result.entries);
  return result;
}

export const verify = (root: string): VerifyResult => verifyManifest(root, listDataFiles);

/**
 * Builds the release assets into `dist/` (never committed): the tile pyramids, the heightmaps and the item icons, with a
 * manifest of checksums. The heightmap and the icons are the extracted images, copied as they are.
 */
export async function buildAllAssets(config: Config, distDir: string): Promise<void> {
  const meta = readCacheMeta(config.rawDir);
  const worlds: Record<string, unknown> = {};
  for (const w of WORLDS) {
    const png = join(config.rawDir, "maps", `${w.id}.png`);
    const out = join(distDir, "maps", w.id);
    const heightSource = join(config.rawDir, "maps", `${w.id}.height.png`);
    const sourceSha256 = hashFile(png);
    const kept = reusableWorld(distDir, w.id, sourceSha256, hashFile(heightSource));
    if (kept) {
      console.log(`${w.id}: unchanged, kept`);
      worlds[w.id] = kept;
      continue;
    }
    rmSync(out, { recursive: true, force: true });
    console.log(`tiling ${w.id}`);
    const report = await buildTiles(png, out);

    copyFileSync(heightSource, join(out, "heightmap.png"));
    worlds[w.id] = {
      sourceSha256,
      maxZoom: report.maxZoom,
      files: report.files,
      heightmap: { path: "heightmap.png", sha256: hashFile(heightSource), bytes: statSync(heightSource).size },
      tiling: CURRENT_TILING,
    };
  }
  console.log("copying icons");
  const icons = copyIcons(join(config.rawDir, ICONS_DIR), join(distDir, "icons"), iconReferences("."));

  mkdirSync(distDir, { recursive: true });
  const manifest = { schemaVersion: 1, gameBuild: meta.gameBuild, cue4parse: meta.cue4parse, worlds, icons };
  writeFileSync(join(distDir, "RELEASE-MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");
}
