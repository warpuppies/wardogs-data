import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashFile } from "../src/maps/tiles.js";
import { CURRENT_TILING, listedAssets, readReleaseManifest, reusableWorld, verifyAssets } from "../src/release.js";

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const asset = (file: string, path: string) => ({ path, sha256: hashFile(file), bytes: readFileSync(file).length });

/** A small repo root with data files and a matching dist/: one world with two tiles and a heightmap, and two icons. */
function makeRepo(): { root: string; dist: string } {
  const root = mkdtempSync(join(tmpdir(), "wardogs-release-"));
  const dist = join(root, "dist");
  put(join(root, "data/items.json"), JSON.stringify({ items: [{ id: "A" }, { id: "B" }] }));
  put(join(root, "data/README.md"), "# dictionary\n");
  put(join(dist, "maps/w1/tiles/0/0/0.webp"), "tile-a");
  put(join(dist, "maps/w1/tiles/1/0/0.webp"), "tile-b");
  put(join(dist, "maps/w1/heightmap.png"), "height");
  put(join(dist, "icons/UI/A.png"), "icon-a");
  put(join(dist, "icons/UI/B.png"), "icon-b");
  const tile = (p: string) => asset(join(dist, "maps/w1", p), p);
  put(
    join(dist, "RELEASE-MANIFEST.json"),
    JSON.stringify({
      schemaVersion: 1,
      gameBuild: "42",
      cue4parse: "abcdef0123456789abcdef0123456789abcdef01",
      worlds: { w1: { sourceSha256: "x", maxZoom: 1, files: [tile("tiles/0/0/0.webp"), tile("tiles/1/0/0.webp")], heightmap: tile("heightmap.png") } },
      icons: [asset(join(dist, "icons/UI/A.png"), "UI/A.png"), asset(join(dist, "icons/UI/B.png"), "UI/B.png")],
    }),
  );
  return { root, dist };
}

describe("verifyAssets", () => {
  it("passes when every listed file matches", () => {
    const { dist } = makeRepo();
    expect(verifyAssets(dist)).toEqual([]);
  });

  it("lists the files the manifest names, with their paths inside dist", () => {
    const { dist } = makeRepo();
    expect(listedAssets(readReleaseManifest(dist)).map((a) => a.path).sort()).toEqual([
      "icons/UI/A.png",
      "icons/UI/B.png",
      "maps/w1/heightmap.png",
      "maps/w1/tiles/0/0/0.webp",
      "maps/w1/tiles/1/0/0.webp",
    ]);
  });

  it("reports a changed file, a changed size, a missing file and an unlisted file", () => {
    const { dist } = makeRepo();
    put(join(dist, "icons/UI/A.png"), "icon-X"); // same size, different content
    put(join(dist, "maps/w1/heightmap.png"), "taller-than-before");
    rmSync(join(dist, "maps/w1/tiles/0/0/0.webp"));
    put(join(dist, "icons/UI/Extra.png"), "stray");
    expect(verifyAssets(dist).sort()).toEqual([
      "checksum differs: icons/UI/A.png",
      "missing: maps/w1/tiles/0/0/0.webp",
      "not in the manifest: icons/UI/Extra.png",
      "size differs: maps/w1/heightmap.png",
    ]);
  });

  it("explains how to fix a missing manifest", () => {
    expect(verifyAssets(mkdtempSync(join(tmpdir(), "wardogs-empty-")))[0]).toMatch(/pnpm assets/);
  });
});

describe("reusableWorld", () => {
  /** Rewrites the fixture's manifest with the tiler settings and the checksums the check compares. */
  const withTiling = (dist: string, tiling: object | undefined = CURRENT_TILING) => {
    const manifest = JSON.parse(readFileSync(join(dist, "RELEASE-MANIFEST.json"), "utf8"));
    manifest.worlds.w1.sourceSha256 = "source";
    if (tiling) manifest.worlds.w1.tiling = tiling;
    writeFileSync(join(dist, "RELEASE-MANIFEST.json"), JSON.stringify(manifest));
    return manifest.worlds.w1.heightmap.sha256 as string;
  };

  it("keeps a world whose source, heightmap and tiler settings are unchanged and whose files are all there", () => {
    const { dist } = makeRepo();
    const height = withTiling(dist);
    expect(reusableWorld(dist, "w1", "source", height)?.maxZoom).toBe(1);
  });

  it("rebuilds when the source or heightmap changed, the tiler settings differ or are unknown, or a file is missing or resized", () => {
    const { dist } = makeRepo();
    const height = withTiling(dist);
    expect(reusableWorld(dist, "w1", "other", height)).toBeUndefined();
    expect(reusableWorld(dist, "w1", "source", "0".repeat(64))).toBeUndefined();
    expect(reusableWorld(dist, "w2", "source", height)).toBeUndefined();
    withTiling(dist, { tileSize: CURRENT_TILING.tileSize, webpQuality: CURRENT_TILING.webpQuality - 1 });
    expect(reusableWorld(dist, "w1", "source", height)).toBeUndefined();
    withTiling(dist, undefined);
    const manifest = JSON.parse(readFileSync(join(dist, "RELEASE-MANIFEST.json"), "utf8"));
    delete manifest.worlds.w1.tiling;
    writeFileSync(join(dist, "RELEASE-MANIFEST.json"), JSON.stringify(manifest));
    expect(reusableWorld(dist, "w1", "source", height)).toBeUndefined();
    withTiling(dist);
    put(join(dist, "maps/w1/tiles/0/0/0.webp"), "tile-a-longer");
    expect(reusableWorld(dist, "w1", "source", height)).toBeUndefined();
    rmSync(join(dist, "maps/w1/heightmap.png"));
    expect(reusableWorld(dist, "w1", "source", height)).toBeUndefined();
  });

  it("rebuilds when there is no readable manifest", () => {
    expect(reusableWorld(mkdtempSync(join(tmpdir(), "wardogs-nodist-")), "w1", "source", "x")).toBeUndefined();
  });
});
