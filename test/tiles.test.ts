import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { buildTiles, rawInputOptions, readPngSize } from "../src/maps/tiles.js";

async function makePng(size: number): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "wardogs-tiles-"));
  const path = join(dir, "src.png");
  // A gradient so tiles differ from one another.
  const raw = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) raw.set([x % 256, y % 256, (x + y) % 256], (y * size + x) * 3);
  await sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toFile(path);
  return path;
}

describe("readPngSize", () => {
  it("reads dimensions from the header", async () => {
    expect(readPngSize(await makePng(512))).toEqual({ width: 512, height: 512 });
  });
});

describe("rawInputOptions", () => {
  it("lifts sharp's pixel limit, which a 16384 px world exceeds", () => {
    // Regression: 16384 * 16384 is above sharp's default limit (0x3FFF * 0x3FFF), so raw inputs failed on real data.
    expect(16384 * 16384).toBeGreaterThan(0x3fff * 0x3fff);
    expect(rawInputOptions(16384)).toEqual({ raw: { width: 16384, height: 16384, channels: 3 }, limitInputPixels: false });
  });
});

describe("buildTiles", () => {
  it("cuts a 512 px image into a two-level 256 px pyramid", async () => {
    const out = mkdtempSync(join(tmpdir(), "wardogs-out-"));
    const report = await buildTiles(await makePng(512), out);
    expect(report.maxZoom).toBe(1);
    expect(report.files.map((f) => f.path)).toEqual([
      "tiles/0/0/0.webp",
      "tiles/1/0/0.webp",
      "tiles/1/0/1.webp",
      "tiles/1/1/0.webp",
      "tiles/1/1/1.webp",
    ]);
    for (const f of report.files) {
      const meta = await sharp(join(out, f.path)).metadata();
      expect([meta.width, meta.height, meta.format]).toEqual([256, 256, "webp"]);
      expect(f.bytes).toBe(readFileSync(join(out, f.path)).length);
    }
  });

  it("puts column x along the image's x axis and row y along its y axis", async () => {
    const out = mkdtempSync(join(tmpdir(), "wardogs-out-"));
    // Left half red, bottom half blue-tinted: tile (1,0) is right/top, tile (0,1) is left/bottom.
    const size = 512;
    const raw = Buffer.alloc(size * size * 3);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) raw.set([x < 256 ? 250 : 10, 10, y < 256 ? 10 : 250], (y * size + x) * 3);
    const dir = mkdtempSync(join(tmpdir(), "wardogs-quad-"));
    const png = join(dir, "q.png");
    await sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toFile(png);
    await buildTiles(png, out);
    const px = async (path: string) => [...(await sharp(join(out, path)).raw().toBuffer()).subarray(0, 3)];
    const [r10, , b10] = await px("tiles/1/1/0.webp"); // right, top
    const [r01, , b01] = await px("tiles/1/0/1.webp"); // left, bottom
    expect((r10 ?? 0) < 100 && (b10 ?? 255) < 100).toBe(true);
    expect((r01 ?? 0) > 150 && (b01 ?? 0) > 150).toBe(true);
  });

  it("rejects images that are not square with a size of 256 * 2^n", async () => {
    await expect(buildTiles(await makePng(300), mkdtempSync(join(tmpdir(), "x-")))).rejects.toThrow(/256/);
  });

  it("writes the 4096 px overview when the pyramid reaches that size", async () => {
    // Keep the test cheap: a 4096 image of one flat colour.
    const dir = mkdtempSync(join(tmpdir(), "wardogs-big-"));
    const png = join(dir, "big.png");
    await sharp({ create: { width: 4096, height: 4096, channels: 3, background: { r: 120, g: 160, b: 80 } } }).png().toFile(png);
    const out = join(dir, "out");
    const report = await buildTiles(png, out);
    expect(report.maxZoom).toBe(4);
    expect(existsSync(join(out, "overview.webp"))).toBe(true);
    expect(report.files.some((f) => f.path === "overview.webp")).toBe(true);
  }, 60_000);
});
