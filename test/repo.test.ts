import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MapFile, BuildingsFile, ItemsFile } from "../src/schema.js";
import { verifyTrackedIcons } from "../src/icons.js";
import { WORLDS } from "../src/maps/worlds.js";
import { verify } from "../src/pipeline.js";

/** Checks of the committed data itself. They need neither the game nor the cache. */
describe("committed data", () => {
  it("matches data/MANIFEST.json (nothing edited by hand)", () => {
    const result = verify(process.cwd());
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  describe.each(WORLDS)("$id", (w) => {
    const read = <T>(name: string): unknown => JSON.parse(readFileSync(join("data", "maps", w.id, name), "utf8")) as T;

    it("has valid map metadata", () => {
      const map = MapFile.parse(read("map.json"));
      expect(map.world).toBe(w.folder);
      expect(map.image.width).toBe(256 * 2 ** map.tiles.maxZoom);
      // The padding rule: the image may extend a little past the bounds, never fall short of them.
      expect(map.image.padding.right).toBeLessThan(map.image.width * 0.01);
    });

    it("has valid building boxes", () => {
      const file = BuildingsFile.parse(read("buildings.json"));
      expect(file.count).toBe(file.buildings.length);
      for (const b of file.buildings) {
        expect(b.max[0]).toBeGreaterThan(b.min[0]);
        expect(b.max[1]).toBeGreaterThan(b.min[1]);
        expect(b.max[2]).toBeGreaterThan(b.min[2]);
        expect(b.max[0] - b.min[0]).toBeLessThan(200); // no building is 200 m wide: guards against unit mix-ups
      }
    });
  });

  it("keeps Kavkazi's building count up", () => {
    const file = BuildingsFile.parse(JSON.parse(readFileSync(join("data", "maps", "kavkazi", "buildings.json"), "utf8")));
    expect(file.count).toBeGreaterThanOrEqual(300);
  });
});

describe("pinned tool versions", () => {
  it("pins the .NET SDK to the major version the extractor targets", () => {
    const sdk = JSON.parse(readFileSync(join("extractor", "global.json"), "utf8")).sdk as { version: string; rollForward: string };
    const target = /<TargetFramework>net(\d+)\.\d+<\/TargetFramework>/.exec(readFileSync(join("extractor", "Unpack.csproj"), "utf8"));
    expect(target).not.toBeNull();
    expect(sdk.version.split(".")[0]).toBe(target![1]);
    // Never roll to a newer major: the extractor's output must not depend on the machine's newest SDK.
    expect(["latestPatch", "latestFeature", "disable"]).toContain(sdk.rollForward);
  });

  it("pins the CUE4Parse revision to a full commit hash", () => {
    expect(readFileSync(join("extractor", "CUE4PARSE_REVISION"), "utf8").trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("pins the package manager and Node", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { packageManager: string; engines: { node: string } };
    expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(pkg.engines.node).toBeTruthy();
  });
});

describe("icons", () => {
  const items = ItemsFile.parse(JSON.parse(readFileSync(join("data", "items.json"), "utf8"))).items;
  const listed = new Set((JSON.parse(readFileSync("assets/icons.manifest.json", "utf8")) as { files: Array<{ path: string }> }).files.map((f) => f.path));

  it("are all listed in assets/icons.manifest.json, which is tracked even though the images are not", () => {
    const missing = [...new Set(items.map((i) => i.icon))].filter((p): p is string => p !== undefined && !listed.has(p));
    expect(missing).toEqual([]);
  });

  it("include an image for every vehicle variant", () => {
    const byId = new Map(items.map((i) => [i.id, i]));
    const vehicles = (JSON.parse(readFileSync(join("data", "vehicles.json"), "utf8")) as { vehicles: Array<{ id: string }> }).vehicles;
    expect(vehicles.length).toBeGreaterThanOrEqual(20);
    const missing = vehicles.filter((v) => {
      const icon = byId.get(v.id)?.icon;
      return icon === undefined || !listed.has(icon);
    });
    expect(missing.map((v) => v.id)).toEqual([]);
  });

  // The images are ignored by git, so this runs only where `pnpm icons` has been run.
  it.skipIf(!existsSync(join("assets", "icons")))("match their manifest, file by file", () => {
    expect(verifyTrackedIcons(process.cwd(), items.map((i) => i.icon))).toEqual([]);
  });
});
