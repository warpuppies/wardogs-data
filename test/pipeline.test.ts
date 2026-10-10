import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { writeCacheMeta } from "../src/cache.js";
import { hasChanges } from "../src/generated.js";
import { MANIFEST_PATH } from "../src/manifest.js";
import { gamePath } from "../src/maps/terrain.js";
import { writePng16 } from "./png16.js";
import { SERVER_BROWSER_TABLE, WORLDS, worldMapDataPath } from "../src/maps/worlds.js";
import { apply, plan, verify } from "../src/pipeline.js";
import { writeGameplayFixture, writeMetaFixture, writeMovementFixture } from "./gameplayFixture.js";

function put(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A tiny but complete cache: one item, and for every world a minimap asset, an image and a building. */
async function makeCache(): Promise<string> {
  const raw = join(mkdtempSync(join(tmpdir(), "wardogs-pipe-")), "raw");
  writeCacheMeta(raw, { gameBuild: "100", cue4parse: "abc123" });

  put(join(raw, "items/Wardogs/Content/Items/T/ID_Widget.json"), JSON.stringify([
    { Type: "BHInventoryItemDefinition", Properties: { ItemId: { TagName: "Id.Item.Widget" }, DisplayName: { LocalizedString: "Widget" } } },
  ]));

  writeGameplayFixture(raw);
  writeMovementFixture(raw);
  writeMetaFixture(raw);

  const rows = Object.fromEntries(WORLDS.map((w) => [w.serverRow, { DisplayName: { CultureInvariantString: `Map ${w.id}` } }]));
  put(join(raw, "maps/json", `${SERVER_BROWSER_TABLE}.json`), JSON.stringify([{ Type: "DataTable", Rows: rows }]));

  for (const w of WORLDS) {
    put(join(raw, "maps/json", `${worldMapDataPath(w)}.json`), JSON.stringify([
      // 512 px at 100 cm/px; bounds 510 m wide, so 2 px of padding.
      { Type: "WDMinimapTextureData", Properties: { SizeX: 512, WorldUnitsPerPixel: 100, Bounds: { Min: { X: 0, Y: 0 }, Max: { X: 51000, Y: 51000 } } } },
    ]));
    await sharp({ create: { width: 512, height: 512, channels: 3, background: { r: 10, g: 120, b: 60 } } }).png().toFile(join(raw, "maps", `${w.id}.png`));
    // Terrain: 64 px, one flat height. The volume spans -100..100 m in Z, and the value puts the ground at about -3 m,
    // which is where the fixture house starts, so the buildings-on-terrain check passes.
    put(join(raw, "maps", `${w.id}.rvt.json`), JSON.stringify([
      { virtualTexture: "RuntimeVirtualTexture'Other'", streamingTexture: "/Game/Other.1", location: { X: 0, Y: 0, Z: 0 }, scale: { X: 1, Y: 1, Z: 1 } },
      { virtualTexture: "RuntimeVirtualTexture'Height'", streamingTexture: `${gamePath(w.heightTexture)}.1`, location: { X: 0, Y: 0, Z: -10000 }, rotation: null, scale: { X: 51000, Y: 51000, Z: 20000 } },
    ]));
    const flat = new Uint16Array(64 * 64).fill(31785);
    writePng16(join(raw, "maps", `${w.id}.height.png`), 64, 64, flat);
    put(join(raw, "objects", `${w.id}.actors.jsonl`), JSON.stringify({ cls: "B_EquipmentVendor_C", name: `${w.id}-vendor`, package: "cell.umap", location: { X: 100000, Y: 200000, Z: 0 }, props: {} }) + "\n");
    put(join(raw, "maps", `${w.id}.parts.jsonl`), [
      JSON.stringify({ t: "owner", actor: `${w.id}-house`, cls: "B_Residential_House_01_C" }),
      JSON.stringify({ t: "part", actor: `${w.id}-house`, origin: { X: 1000, Y: 1000, Z: 0 }, extent: { X: 500, Y: 500, Z: 300 } }),
    ].join("\n") + "\n");
  }
  return raw;
}

const newRoot = () => mkdtempSync(join(tmpdir(), "wardogs-root-"));

describe("pipeline as code", () => {
  it("produces every dataset's files plus a manifest", async () => {
    const { entries } = await plan(newRoot(), await makeCache());
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("data/items.json");
    expect(paths).toContain(MANIFEST_PATH);
    for (const w of WORLDS) {
      expect(paths).toContain(`data/maps/${w.id}/map.json`);
      expect(paths).toContain(`data/maps/${w.id}/buildings.json`);
      expect(paths).toContain(`data/maps/${w.id}/buildings.geojson`);
      expect(paths).toContain(`data/maps/${w.id}/terrain.json`);
    }
    expect(entries.every((e) => e.action === "create")).toBe(true);
  });

  it("plan writes nothing", async () => {
    const root = newRoot();
    await plan(root, await makeCache());
    expect(verify(root).ok).toBe(false); // still no manifest
  });

  it("apply is idempotent: a second plan has no changes", async () => {
    const root = newRoot();
    const raw = await makeCache();
    await apply(root, raw);
    expect(hasChanges((await plan(root, raw)).entries)).toBe(false);
    const first = readFileSync(join(root, "data/items.json"), "utf8");
    await apply(root, raw);
    expect(readFileSync(join(root, "data/items.json"), "utf8")).toBe(first);
  });

  it("verify passes after apply and needs only the data folder", async () => {
    const root = newRoot();
    await apply(root, await makeCache());
    expect(verify(root)).toMatchObject({ ok: true });
  });

  it("verify fails when a generated file is edited by hand", async () => {
    const root = newRoot();
    await apply(root, await makeCache());
    const file = join(root, "data/maps/kavkazi/buildings.json");
    writeFileSync(file, readFileSync(file, "utf8").replace('"count": 1', '"count": 2'));
    const result = verify(root);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(["modified by hand or stale: data/maps/kavkazi/buildings.json"]);
  });

  it("plan shows a hand edit as an update, and apply reverts it", async () => {
    const root = newRoot();
    const raw = await makeCache();
    await apply(root, raw);
    writeFileSync(join(root, "data/items.json"), "{}");
    expect((await plan(root, raw)).entries.find((e) => e.path === "data/items.json")?.action).toBe("update");
    await apply(root, raw);
    expect(verify(root).ok).toBe(true);
  });

  it("apply removes files the pipeline no longer produces", async () => {
    const root = newRoot();
    const raw = await makeCache();
    await apply(root, raw);
    put(join(root, "data/old-dataset.json"), "{}");
    expect(verify(root).problems).toEqual(["not generated by the pipeline: data/old-dataset.json"]);
    await apply(root, raw);
    expect(verify(root).ok).toBe(true);
  });

  it("records the provenance of the cache in the manifest", async () => {
    const root = newRoot();
    await apply(root, await makeCache());
    const manifest = JSON.parse(readFileSync(join(root, MANIFEST_PATH), "utf8"));
    expect(manifest.provenance).toEqual({ gameBuild: "100", cue4parse: "abc123" });
  });

  it("derives meter-based map metadata and building boxes from the cache", async () => {
    const root = newRoot();
    await apply(root, await makeCache());
    const map = JSON.parse(readFileSync(join(root, "data/maps/kavkazi/map.json"), "utf8"));
    expect(map).toMatchObject({ name: "Map kavkazi", units: "meters", image: { metersPerPixel: 1, padding: { right: 2, bottom: 2 } } });
    const b = JSON.parse(readFileSync(join(root, "data/maps/kavkazi/buildings.json"), "utf8"));
    expect(b.buildings[0]).toMatchObject({ kind: "house", min: [5, 5, -3], max: [15, 15, 3] });
    const t = JSON.parse(readFileSync(join(root, "data/maps/kavkazi/terrain.json"), "utf8"));
    expect(t).toMatchObject({ units: "meters", zRange: { min: -100, max: 100 }, heightmap: { width: 64, bitDepth: 16 } });
    expect(t.bounds).toEqual({ min: [0, 0], max: [510, 510] });
  });
});
