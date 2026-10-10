import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { readGameBuild } from "../src/extract/steam.js";
import { parseUsmapHeader } from "../src/extract/usmap.js";
import { summarizeKeyReports, verifyKeyAgainstInstall } from "../src/extract/verifyKey.js";

/**
 * Checks against a real game install. They run only when the environment points at one
 * (WARDOGS_INSTALL_DIR, WARDOGS_AES_KEY[_FILE], WARDOGS_USMAP), so CI skips them.
 * After a game update, these are the first tests to fail if the key or mappings went stale.
 */
const configured = Boolean(process.env.WARDOGS_INSTALL_DIR && process.env.WARDOGS_USMAP);

describe.skipIf(!configured)("live game install", () => {
  const config = () => loadConfig();

  it("has the Paks folder", () => {
    expect(existsSync(config().paksDir)).toBe(true);
  });

  it("decrypts every encrypted container with the configured key", async () => {
    const counts = summarizeKeyReports(await verifyKeyAgainstInstall(config().paksDir, config().aesKey));
    expect(counts.wrong, "the AES key no longer matches: a game update probably rotated it").toBe(0);
    expect(counts.unsupported).toBe(0);
    expect(counts.ok).toBeGreaterThan(0);
  });

  it("has a valid mappings file", () => {
    expect(() => parseUsmapHeader(readFileSync(config().usmapPath))).not.toThrow();
  });

  it("has data/items.json extracted from this build", () => {
    const data = JSON.parse(readFileSync("data/items.json", "utf8")) as { gameBuild: string };
    expect(data.gameBuild, "installed build differs from committed data: run `pnpm update-data`").toBe(readGameBuild(config().installDir));
  });
});
