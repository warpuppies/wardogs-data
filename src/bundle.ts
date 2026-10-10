import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { walk } from "./generated.js";
import { hashFile } from "./maps/tiles.js";
import { writeZip, type ZipEntry } from "./zip.js";

export type BundleKind = "small" | "full";

export interface ZipBundleFile {
  kind: BundleKind;
  name: string;
  sha256: string;
  bytes: number;
}

/** Build id of the data in `root`, from `data/MANIFEST.json`. */
export function readBuild(root: string): string {
  const manifest = JSON.parse(readFileSync(join(root, "data", "MANIFEST.json"), "utf8")) as { provenance?: { gameBuild?: string } };
  const build = manifest.provenance?.gameBuild;
  if (!build) throw new Error("data/MANIFEST.json has no provenance.gameBuild. Run `pnpm apply`.");
  return build;
}

export const zipName = (build: string, kind: BundleKind): string => (kind === "small" ? `wardogs-data-${build}.zip` : `wardogs-data-${build}-full.zip`);

/** Top-level files that ship in every archive when they exist. */
const TOP_LEVEL = ["README.md", "LICENSE"];

/**
 * The files of an archive, inside a folder named after the build. `small` holds `data/` (JSON, schemas, CSV and the
 * dictionary), the README and the license. `full` adds `assets/`: the item icons and the map tiles and heightmaps,
 * with their manifests. The images are not in git, so the full archive can only be built where `pnpm icons` and
 * `pnpm maps` have been run.
 */
export function bundleEntries(root: string, build: string, kind: BundleKind): ZipEntry[] {
  const prefix = `wardogs-data-${build}`;
  const entries: ZipEntry[] = [];
  const add = (dir: string): void => {
    for (const rel of walk(join(root, dir), root)) entries.push({ name: `${prefix}/${rel}`, file: join(root, rel) });
  };
  for (const name of TOP_LEVEL) if (existsSync(join(root, name))) entries.push({ name: `${prefix}/${name}`, file: join(root, name) });
  add("data");
  if (kind === "full") {
    for (const dir of ["assets/icons", "assets/maps"]) {
      if (!existsSync(join(root, dir))) throw new Error(`There is no ${dir}/ folder. The full archive needs the icons and map tiles (run \`pnpm icons\` and \`pnpm maps\`).`);
    }
    add("assets");
  }
  return entries;
}

/** Counts from the data files, for the notes. A file that does not exist is left out. */
function dataCounts(root: string): string[] {
  const read = (name: string): Record<string, unknown[]> | undefined => {
    const file = join(root, "data", name);
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown[]>) : undefined;
  };
  const rows: Array<[string, string, string]> = [
    ["items.json", "items", "items and vehicles"],
    ["weapons.json", "weapons", "weapons"],
    ["ammo.json", "projectiles", "projectile definitions"],
    ["attachments.json", "attachments", "attachments"],
    ["vehicles.json", "vehicles", "vehicles with stats"],
    ["damage.json", "rules", "damage rules"],
    ["equipment.json", "armor", "armor and helmet items"],
    ["skills.json", "skills", "role skills"],
    ["rewards.json", "rewards", "cash reward cases"],
    ["buildables.json", "buildables", "buildable structures"],
    ["loot.json", "tables", "loot tables"],
    ["cosmetics.json", "cosmetics", "cosmetics"],
  ];
  return rows.flatMap(([file, key, label]) => {
    const list = read(file)?.[key];
    return list ? [`- ${list.length} ${label}`] : [];
  });
}

/** Bytes the files of an archive take on disk, to size the archive in the notes before it is built. */
const sizeOf = (entries: readonly ZipEntry[]): number => entries.reduce((sum, e) => sum + statSync(e.file).size, 0);

const mb = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024 / 1024))} MB`;

/**
 * Bytes of the icons, map tiles and heightmaps, from their manifests. The images themselves are not in git, so this
 * must not look at the disk: CI builds the notes without them.
 */
export function imageBytes(root: string): number {
  const read = (name: string): unknown => {
    const file = join(root, "assets", name);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  };
  const sum = (files: unknown): number => (Array.isArray(files) ? files.reduce((s: number, f: { bytes?: number }) => s + (f.bytes ?? 0), 0) : 0);
  const icons = read("icons.manifest.json") as { files?: unknown };
  const maps = read("maps.manifest.json") as { worlds?: Record<string, { files?: unknown; heightmap?: { bytes?: number } }> };
  return sum(icons.files) + Object.values(maps.worlds ?? {}).reduce((s, w) => s + sum(w.files) + (w.heightmap?.bytes ?? 0), 0);
}

/** Release notes, derived from the data files and the folders, so they cannot disagree with the archives. */
export function bundleNotes(root: string, build: string): string {
  const small = bundleEntries(root, build, "small");
  const images = imageBytes(root);
  return [
    `# Wardogs data, game build ${build}`,
    "",
    "Structured data for the game at this build. `data/README.md` inside either archive describes every file and field, and says what is complete and what is missing.",
    "",
    "## Contents",
    "",
    ...dataCounts(root),
    "",
    "## Files",
    "",
    "| File | About | Contents |",
    "| --- | --- | --- |",
    `| \`${zipName(build, "small")}\` | ${mb(sizeOf(small))} unpacked | JSON, JSON Schema and CSV data, the data dictionary, the README and the license. |`,
    `| \`${zipName(build, "full")}\` | ${mb(sizeOf(small) + images)} unpacked | Everything above, plus the item icons (PNG) and the map tiles (WebP) and heightmaps of every world. |`,
    "",
    "The icons and map tiles are already compressed, so the full zip downloads at about its unpacked size. Each archive has a `.sha256` file next to it. The archives are reproducible: the same files give the same bytes.",
    "",
    "Unofficial project, not affiliated with the game's developer or publisher. The repository is released under the Unlicense; the game's names, numbers and imagery remain the property of the developer and publisher.",
    "",
  ].join("\n");
}

/**
 * Builds the archives of the given kinds, their checksum files and the release notes into `outDir`. Publishes nothing.
 * Verifying the data and the assets is the caller's job (`pnpm bundle` runs `verify` first).
 */
export function buildZipBundles(root: string, outDir: string, kinds: readonly BundleKind[]): { tag: string; build: string; files: ZipBundleFile[] } {
  const build = readBuild(root);
  mkdirSync(outDir, { recursive: true });
  const files: ZipBundleFile[] = [];
  for (const kind of kinds) {
    const name = zipName(build, kind);
    const out = join(outDir, name);
    writeZip(bundleEntries(root, build, kind), out);
    const sha256 = hashFile(out);
    writeFileSync(join(outDir, `${name}.sha256`), `${sha256}  ${name}\n`);
    files.push({ kind, name, sha256, bytes: statSync(out).size });
  }
  writeFileSync(join(outDir, "RELEASE-NOTES.md"), bundleNotes(root, build));
  return { tag: `build-${build}`, build, files };
}
