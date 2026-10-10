import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/** Steam app id of the game; used to find the install manifest and its build id. */
export const STEAM_APP_ID = "1867240";

export interface Config {
  /** Root of the game install (the folder that contains `Wardogs/`). */
  installDir: string;
  /** Folder holding the .pak / .utoc / .ucas files. */
  paksDir: string;
  /** Hex AES-256 key (64 chars, no 0x). Never committed. */
  aesKey: string;
  /** Path to the .usmap mappings file. Never committed. */
  usmapPath: string;
  /** Raw decoded JSON cache (gitignored). */
  rawDir: string;
  /** Committed output. */
  dataDir: string;
}

export function normalizeAesKey(input: string): string {
  const key = input.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("AES key must be 64 hex characters (32 bytes), optionally prefixed with 0x.");
  }
  return key.toLowerCase();
}

function readKey(env: NodeJS.ProcessEnv): string {
  if (env.WARDOGS_AES_KEY) return normalizeAesKey(env.WARDOGS_AES_KEY);
  const file = env.WARDOGS_AES_KEY_FILE;
  if (file && existsSync(file)) return normalizeAesKey(readFileSync(file, "utf8"));
  throw new Error("Set WARDOGS_AES_KEY or WARDOGS_AES_KEY_FILE.");
}

/** Loads configuration from the environment. Throws a readable error if anything is missing. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  const installDir = env.WARDOGS_INSTALL_DIR;
  if (!installDir) throw new Error("Set WARDOGS_INSTALL_DIR to the game install folder.");
  const usmapPath = env.WARDOGS_USMAP;
  if (!usmapPath) throw new Error("Set WARDOGS_USMAP to the .usmap mappings file.");
  return {
    installDir,
    paksDir: resolve(installDir, "Wardogs", "Content", "Paks"),
    aesKey: readKey(env),
    usmapPath,
    rawDir: resolve(cwd, ".cache", "raw"),
    dataDir: resolve(cwd, "data"),
  };
}
