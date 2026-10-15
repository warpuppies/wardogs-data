import { spawn } from "node:child_process";
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

/** Runs at most `limit` jobs at a time. Jobs waiting for a place go by priority (the lowest number first), then in the order they were asked for. */
export class Pool {
  private running = 0;
  private readonly waiting: Array<{ priority: number; resume: () => void }> = [];
  constructor(readonly limit: number) {}

  async run<T>(job: () => Promise<T>, priority = 0): Promise<T> {
    if (this.running >= this.limit) {
      await new Promise<void>((resume) => {
        const at = this.waiting.findIndex((w) => w.priority > priority);
        this.waiting.splice(at < 0 ? this.waiting.length : at, 0, { priority, resume });
      });
    }
    this.running++;
    try {
      return await job();
    } finally {
      this.running--;
      this.waiting.shift()?.resume();
    }
  }
}

const positive = (value: string | undefined, fallback: number): number => (Number(value) > 0 ? Math.floor(Number(value)) : fallback);

/** How many extractor processes run at once (WARDOGS_JOBS), and how many of the heavy ones, which hold a whole texture in memory (WARDOGS_HEAVY_JOBS). */
const jobs = new Pool(positive(process.env.WARDOGS_JOBS, 9));
const heavyJobs = new Pool(positive(process.env.WARDOGS_HEAVY_JOBS, 4));

const processStart = Date.now();

/** Runs one extractor command. Its output is printed when it ends, so that commands running together do not mix their lines. */
function runDotnet(config: Config, args: string[], heavy = false): Promise<void> {
  // What other steps wait for goes first (the JSON exports and the icons feed the linked packages), then the images, which take longest.
  const priority = args[0] === "export-json" || args[0] === "export-textures" ? 0 : heavy ? 1 : 2;
  if (!existsSync(EXTRACTOR_DLL)) throw new Error("Extractor is not built. Run `pnpm setup:extractor` first.");
  const start = () =>
    jobs.run(
      () =>
        new Promise<void>((resolve, reject) => {
          const started = Date.now();
          const child = spawn(dotnetCommand(), [EXTRACTOR_DLL, ...args], {
            env: { ...process.env, WARDOGS_PAKS_DIR: config.paksDir, WARDOGS_AES_KEY: config.aesKey, WARDOGS_USMAP: config.usmapPath, WARDOGS_CLASS_CACHE: join(config.rawDir, "class-names.json") },
          });
          const out: Buffer[] = [];
          const err: Buffer[] = [];
          child.stdout.on("data", (b: Buffer) => out.push(b));
          child.stderr.on("data", (b: Buffer) => err.push(b));
          child.on("error", reject);
          child.on("close", (status) => {
            process.stdout.write(Buffer.concat(out));
            process.stderr.write(Buffer.concat(err));
            console.log(`${args[0]} ${args[1] === undefined ? "" : args[1].slice(0, 70)}: ${((started - processStart) / 1000).toFixed(1)} to ${((Date.now() - processStart) / 1000).toFixed(1)} s`);
            if (status === 0) resolve();
            else reject(new Error(`Extractor failed (exit ${status}): ${args[0]}`));
          });
        }),
      priority,
    );
  return heavy ? heavyJobs.run(start, priority) : start();
}

/** Decodes every matching `.uasset` to JSON under `outDir`, which is cleared first unless `keep` is set (to add to a folder). */
export async function exportJson(config: Config, include: string, exclude: string, outDir: string, keep = false): Promise<void> {
  if (!keep) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  await runDotnet(config, ["export-json", include, exclude, outDir]);
}

/** Writes raw facts about the destructible buildings of one world as JSON lines. */
export function exportBuildingParts(config: Config, worldFolder: string, outFile: string): Promise<void> {
  mkdirSync(dirname(outFile), { recursive: true });
  return runDotnet(config, ["export-building-parts", worldFolder, outFile]);
}

/** Writes the largest decodable level of a texture as PNG. */
export function exportTexture(config: Config, packagePath: string, outFile: string): Promise<void> {
  mkdirSync(dirname(outFile), { recursive: true });
  return runDotnet(config, ["export-texture", packagePath, outFile], true);
}

/**
 * Writes the full-size PNG of each texture package to `outDir`, under the package path (see `iconFilePath`). Textures
 * that cannot be read are listed in `outDir/_errors.txt`. `outDir` is cleared first.
 */
export function exportTextures(config: Config, packages: string[], listFile: string, outDir: string): Promise<void> {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  mkdirSync(dirname(listFile), { recursive: true });
  writeFileSync(listFile, JSON.stringify(packages, null, 2) + "\n");
  return runDotnet(config, ["export-textures", listFile, outDir]);
}

/** Writes the runtime virtual texture volumes (texture references and transforms) of a level as JSON. */
export function exportRvtVolumes(config: Config, levelPackage: string, outFile: string): Promise<void> {
  mkdirSync(dirname(outFile), { recursive: true });
  return runDotnet(config, ["export-rvt-volumes", levelPackage, outFile]);
}

/**
 * Writes the placed actors of a world whose class matches `classPattern` as JSON lines: class, name, package, root
 * transform in centimeters and a shallow copy of the actor's own properties. Scans every cell level of the world.
 */
export function exportActors(config: Config, worldFolder: string, classPattern: string, outFile: string): Promise<void> {
  mkdirSync(dirname(outFile), { recursive: true });
  return runDotnet(config, ["export-actors", worldFolder, classPattern, outFile]);
}
