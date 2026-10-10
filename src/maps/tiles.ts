import { mkdirSync, readFileSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import sharp, { type SharpOptions } from "sharp";
import { sha256 } from "../manifest.js";

export const TILE_SIZE = 256;
/** Lossy WebP quality. Map imagery has no fine text, and lossy keeps a world to a few hundred MB. */
export const WEBP_QUALITY = 90;

/** Reads width and height from a PNG header without decoding the image. */
export function readPngSize(file: string): { width: number; height: number } {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(24);
    readSync(fd, head, 0, 24, 0);
    if (head.toString("latin1", 1, 4) !== "PNG") throw new Error(`${file} is not a PNG.`);
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } finally {
    closeSync(fd);
  }
}

export interface TileFile {
  /** Path relative to the output folder, e.g. `tiles/3/5/2.webp`. */
  path: string;
  sha256: string;
  bytes: number;
}

export interface TileReport {
  maxZoom: number;
  files: TileFile[];
}

interface Raw {
  data: Buffer;
  size: number;
}

/**
 * Sharp rejects inputs above ~268 million pixels by default, and that applies to raw buffers as well as files. A 16384 px
 * world is just over the limit, so every sharp input here goes through these options.
 */
export function rawInputOptions(size: number): SharpOptions {
  return { raw: { width: size, height: size, channels: 3 }, limitInputPixels: false };
}

/**
 * Cuts a square image of size 256 * 2^n into a `z/x/y` WebP pyramid. At the top zoom the tiles are 1:1; each lower zoom
 * halves the image. Column `x` runs along world X and row `y` along world Y, matching the image. Also writes
 * `overview.webp` (the 4096 px level) when the pyramid is deep enough.
 */
export async function buildTiles(pngPath: string, outDir: string): Promise<TileReport> {
  const { width, height } = readPngSize(pngPath);
  const maxZoom = Math.log2(width / TILE_SIZE);
  if (width !== height || !Number.isInteger(maxZoom) || maxZoom < 0) {
    throw new Error(`Image must be square with a size of 256 * 2^n, got ${width}x${height}.`);
  }

  const { data } = await sharp(pngPath, { limitInputPixels: false }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let level: Raw = { data, size: width };
  const files: TileFile[] = [];

  for (let z = maxZoom; z >= 0; z--) {
    if (z < maxZoom) {
      const size = TILE_SIZE * 2 ** z;
      const resized = await sharp(level.data, rawInputOptions(level.size))
        .resize(size, size, { kernel: "lanczos3" })
        .raw()
        .toBuffer();
      level = { data: resized, size };
    }
    const count = level.size / TILE_SIZE;
    for (let y = 0; y < count; y++) {
      for (let x = 0; x < count; x++) {
        const bytes = await sharp(level.data, rawInputOptions(level.size))
          .extract({ left: x * TILE_SIZE, top: y * TILE_SIZE, width: TILE_SIZE, height: TILE_SIZE })
          .webp({ quality: WEBP_QUALITY })
          .toBuffer();
        const path = `tiles/${z}/${x}/${y}.webp`;
        write(join(outDir, path), bytes);
        files.push({ path, sha256: sha256(bytes), bytes: bytes.length });
      }
    }
    if (level.size === 4096) {
      const bytes = await sharp(level.data, rawInputOptions(4096)).webp({ quality: WEBP_QUALITY }).toBuffer();
      write(join(outDir, "overview.webp"), bytes);
      files.push({ path: "overview.webp", sha256: sha256(bytes), bytes: bytes.length });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { maxZoom, files };
}

function write(path: string, bytes: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

export function hashFile(path: string): string {
  return sha256(readFileSync(path));
}
