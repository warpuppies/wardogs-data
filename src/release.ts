import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import { hashFile, TILE_SIZE, WEBP_QUALITY } from "./maps/tiles.js";

const AssetFile = z.object({ path: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().nonnegative() });

/** `dist/RELEASE-MANIFEST.json`: every built asset (map tiles, heightmaps, icons) with its checksum, written by `pnpm assets`. */
export const ReleaseManifest = z.object({
  schemaVersion: z.literal(1),
  gameBuild: z.string(),
  cue4parse: z.string(),
  worlds: z.record(
    z.string(),
    z.object({
      sourceSha256: z.string(),
      maxZoom: z.number().int(),
      files: z.array(AssetFile),
      heightmap: AssetFile,
      /** The tiler settings the tiles were built with. Tiles built with other settings are not reused. */
      tiling: z.object({ tileSize: z.number().int(), webpQuality: z.number() }).optional(),
    }),
  ),
  icons: z.array(AssetFile),
});
export type ReleaseManifest = z.infer<typeof ReleaseManifest>;

export const MANIFEST_FILE = "RELEASE-MANIFEST.json";

/** The tiler settings of this build of the pipeline. */
export const CURRENT_TILING = { tileSize: TILE_SIZE, webpQuality: WEBP_QUALITY } as const;

/**
 * The manifest entry of a world whose tiles and heightmap in `dist/` can be kept: the same source image and heightmap,
 * the same tiler settings, and every listed file present with its size. Returns undefined when anything differs, so the
 * world is rebuilt. Checksums are not recomputed here (`pnpm verify:assets` does that).
 */
export function reusableWorld(distDir: string, id: string, sourceSha256: string, heightmapSha256: string): ReleaseManifest["worlds"][string] | undefined {
  let previous: ReleaseManifest["worlds"][string] | undefined;
  try {
    previous = readReleaseManifest(distDir).worlds[id];
  } catch {
    return undefined;
  }
  if (!previous || previous.sourceSha256 !== sourceSha256 || previous.heightmap.sha256 !== heightmapSha256) return undefined;
  if (previous.tiling?.tileSize !== CURRENT_TILING.tileSize || previous.tiling.webpQuality !== CURRENT_TILING.webpQuality) return undefined;
  const dir = join(distDir, "maps", id);
  const intact = [...previous.files, previous.heightmap].every((f) => existsSync(join(dir, f.path)) && statSync(join(dir, f.path)).size === f.bytes);
  return intact ? previous : undefined;
}

export const readReleaseManifest = (distDir: string): ReleaseManifest => ReleaseManifest.parse(JSON.parse(readFileSync(join(distDir, MANIFEST_FILE), "utf8")));

function* walk(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** Every file the manifest lists, as a path relative to `dist/`. */
export function listedAssets(manifest: ReleaseManifest): Array<z.infer<typeof AssetFile>> {
  return [
    ...Object.entries(manifest.worlds).flatMap(([id, w]) => [
      ...w.files.map((f) => ({ ...f, path: `maps/${id}/${f.path}` })),
      { ...w.heightmap, path: `maps/${id}/${w.heightmap.path}` },
    ]),
    ...manifest.icons.map((f) => ({ ...f, path: `icons/${f.path}` })),
  ];
}

/**
 * Checks `dist/` against its manifest, like `pnpm verify` does for `data/`: every listed file exists with the listed
 * size and checksum, and no file under `maps/` or `icons/` is unlisted. Returns the problems, empty when all is well.
 */
export function verifyAssets(distDir: string): string[] {
  if (!existsSync(join(distDir, MANIFEST_FILE))) return [`${MANIFEST_FILE} is missing. Run \`pnpm assets\`.`];
  const manifest = readReleaseManifest(distDir);
  const problems: string[] = [];
  const listed = listedAssets(manifest);
  for (const asset of listed) {
    const file = join(distDir, asset.path);
    if (!existsSync(file)) problems.push(`missing: ${asset.path}`);
    else if (statSync(file).size !== asset.bytes) problems.push(`size differs: ${asset.path}`);
    else if (hashFile(file) !== asset.sha256) problems.push(`checksum differs: ${asset.path}`);
  }
  const known = new Set(listed.map((a) => a.path));
  for (const dir of ["maps", "icons"]) {
    for (const file of walk(join(distDir, dir))) {
      const rel = relative(distDir, file).replaceAll("\\", "/");
      if (!known.has(rel)) problems.push(`not in the manifest: ${rel}`);
    }
  }
  return problems;
}
