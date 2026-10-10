import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Config } from "../config.js";

export const EXTRACTOR_DLL = resolve("extractor", "bin", "Release", "net10.0", "Unpack.dll");

/** An exclude pattern that matches nothing (an empty regex would match every path). */
export const EXCLUDE_NOTHING = "(?!)";

/** The `dotnet` to run: the one under DOTNET_ROOT when set (an env file cannot extend PATH), else the one on PATH. */
export function dotnetCommand(env: NodeJS.ProcessEnv = process.env): string {
  return env.DOTNET_ROOT ? join(env.DOTNET_ROOT, "dotnet") : "dotnet";
}

function runDotnet(config: Config, args: string[]): void {
  if (!existsSync(EXTRACTOR_DLL)) throw new Error("Extractor is not built. Run `pnpm setup:extractor` first.");
  const result = spawnSync(dotnetCommand(), [EXTRACTOR_DLL, ...args], {
    stdio: "inherit",
    env: {
      ...process.env,
      WARDOGS_PAKS_DIR: config.paksDir,
      WARDOGS_AES_KEY: config.aesKey,
      WARDOGS_USMAP: config.usmapPath,
    },
  });
  if (result.status !== 0) throw new Error(`Extractor failed (exit ${result.status}): ${args[0]}`);
}

/** Decodes every matching `.uasset` to JSON under `outDir`, which is cleared first unless `keep` is set (to add to a folder). */
export function exportJson(config: Config, include: string, exclude: string, outDir: string, keep = false): void {
  if (!keep) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  runDotnet(config, ["export-json", include, exclude, outDir]);
}

/** Writes raw facts about the destructible buildings of one world as JSON lines. */
export function exportBuildingParts(config: Config, worldFolder: string, outFile: string): void {
  mkdirSync(dirname(outFile), { recursive: true });
  runDotnet(config, ["export-building-parts", worldFolder, outFile]);
}

/** Writes the largest decodable level of a texture as PNG. */
export function exportTexture(config: Config, packagePath: string, outFile: string): void {
  mkdirSync(dirname(outFile), { recursive: true });
  runDotnet(config, ["export-texture", packagePath, outFile]);
}

/**
 * Writes the full-size PNG of each texture package to `outDir`, under the package path (see `iconFilePath`). Textures
 * that cannot be read are listed in `outDir/_errors.txt`. `outDir` is cleared first.
 */
export function exportTextures(config: Config, packages: string[], listFile: string, outDir: string): void {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  mkdirSync(dirname(listFile), { recursive: true });
  writeFileSync(listFile, JSON.stringify(packages, null, 2) + "\n");
  runDotnet(config, ["export-textures", listFile, outDir]);
}

/** Writes the runtime virtual texture volumes (texture references and transforms) of a level as JSON. */
export function exportRvtVolumes(config: Config, levelPackage: string, outFile: string): void {
  mkdirSync(dirname(outFile), { recursive: true });
  runDotnet(config, ["export-rvt-volumes", levelPackage, outFile]);
}

/**
 * Writes the placed actors of a world whose class matches `classPattern` as JSON lines: class, name, package, root
 * transform in centimeters and a shallow copy of the actor's own properties. Scans every cell level of the world, which
 * takes several minutes per world.
 */
export function exportActors(config: Config, worldFolder: string, classPattern: string, outFile: string): void {
  mkdirSync(dirname(outFile), { recursive: true });
  runDotnet(config, ["export-actors", worldFolder, classPattern, outFile]);
}
