import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { PackageIndex } from "../transform/packages.js";
import { collectVehicleConfigs } from "../transform/vehicleConfigs.js";
import { EXCLUDE_NOTHING, exportJson } from "./run.js";

/**
 * An include pattern for `export-json` that matches exactly the files of the given packages (`/Game/X` is
 * `Wardogs/Content/X.uasset` and `/Plugin/X` is `Wardogs/Plugins/.../Plugin/Content/X.uasset`).
 */
export function packagesPattern(packages: readonly string[]): string {
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const alternatives = packages.flatMap((pkg) => {
    const game = /^\/Game\/(.+)$/.exec(pkg);
    if (game) return [`Wardogs/Content/${escape(game[1]!)}\\.uasset`];
    const plugin = /^\/([^/]+)\/(.+)$/.exec(pkg);
    return plugin ? [`Wardogs/Plugins/(?:[^/]+/)*${escape(plugin[1]!)}/Content/${escape(plugin[2]!)}\\.uasset`] : [];
  });
  return alternatives.length ? `(${alternatives.join("|")})$` : EXCLUDE_NOTHING;
}

/** Most rounds of following references; the vehicle closure settles in two or three. */
const MAX_ROUNDS = 8;

/**
 * Adds to the gameplay cache every package the vehicle configs link to that the name patterns did not catch (input
 * mappings, audio data, flight curves, camera shakes...), then the packages those link to, until nothing new is found.
 * Packages that are not in the game files stay unresolved. Returns the packages added.
 */
export function extractLinkedPackages(config: Config, gameplayDir: string, itemsDir: string, log: (line: string) => void = console.log): string[] {
  const tried = new Set<string>();
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const index = new PackageIndex([gameplayDir, ...(existsSync(itemsDir) ? [itemsDir] : [])]);
    const { unresolved } = collectVehicleConfigs(index, () => undefined, () => []);
    const wanted = unresolved.filter((p) => !tried.has(p.toLowerCase()));
    if (!wanted.length) return [...tried];
    for (const p of wanted) tried.add(p.toLowerCase());
    log(`linked packages, round ${round}: ${wanted.length} to extract`);
    exportJson(config, packagesPattern(wanted), EXCLUDE_NOTHING, gameplayDir, true);
  }
  throw new Error(`The vehicle configs still link to new packages after ${MAX_ROUNDS} rounds: raise MAX_ROUNDS in src/extract/linked.ts.`);
}
