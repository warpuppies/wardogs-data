import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { STEAM_APP_ID } from "../config.js";

/** Extracts a numeric field from Steam's appmanifest (VDF) text. */
export function readManifestField(vdf: string, field: string): string | undefined {
  return new RegExp(`"${field}"\\s+"([^"]*)"`).exec(vdf)?.[1];
}

/**
 * Reads the Steam build id for the install. The manifest lives two folders above the install
 * (`steamapps/appmanifest_<id>.acf`), next to `common/`. Returns "unknown" when it cannot be found.
 */
export function readGameBuild(installDir: string): string {
  const manifest = resolve(installDir, "..", "..", `appmanifest_${STEAM_APP_ID}.acf`);
  if (!existsSync(manifest)) return "unknown";
  return readManifestField(readFileSync(manifest, "utf8"), "buildid") ?? "unknown";
}
