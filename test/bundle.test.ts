import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildZipBundles, bundleEntries, bundleNotes, imageBytes, readBuild, zipName } from "../src/bundle.js";
import { API_VERSION, buildSite, landingPage, siteMatchesIndex } from "../src/site.js";

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A small repo root: data with a manifest, a README, a license and a few assets. */
function makeRoot(build = "42"): string {
  const root = mkdtempSync(join(tmpdir(), "wardogs-bundle-"));
  put(join(root, "data/MANIFEST.json"), JSON.stringify({ provenance: { gameBuild: build }, files: [] }));
  put(join(root, "data/items.json"), JSON.stringify({ gameBuild: build, items: [{ id: "A" }, { id: "B" }] }));
  put(join(root, "data/README.md"), "# Data dictionary\n");
  put(join(root, "data/maps/w1/map.json"), "{}");
  put(join(root, "README.md"), "# readme\n");
  put(join(root, "LICENSE"), "Unlicense\n");
  put(join(root, "assets/icons/UI/A.png"), "icon");
  put(join(root, "assets/maps/w1/tiles/0/0/0.webp"), "tile");
  put(join(root, "assets/icons.manifest.json"), "{}");
  return root;
}

describe("bundles", () => {
  it("reads the build from the data manifest", () => {
    expect(readBuild(makeRoot("777"))).toBe("777");
  });

  it("puts only the data, README and license in the small zip, inside a folder named after the build", () => {
    const names = bundleEntries(makeRoot(), "42", "small").map((e) => e.name).sort();
    expect(names).toEqual(["wardogs-data-42/LICENSE", "wardogs-data-42/README.md", "wardogs-data-42/data/MANIFEST.json", "wardogs-data-42/data/README.md", "wardogs-data-42/data/items.json", "wardogs-data-42/data/maps/w1/map.json"]);
  });

  it("adds the icons, tiles and asset manifests to the full zip", () => {
    const names = bundleEntries(makeRoot(), "42", "full").map((e) => e.name);
    expect(names).toContain("wardogs-data-42/assets/icons/UI/A.png");
    expect(names).toContain("wardogs-data-42/assets/maps/w1/tiles/0/0/0.webp");
    expect(names).toContain("wardogs-data-42/assets/icons.manifest.json");
    expect(names.length).toBe(bundleEntries(makeRoot(), "42", "small").length + 3);
  });

  it("builds the archives, their checksum files and the notes, with the same bytes every time", () => {
    const root = makeRoot();
    const a = buildZipBundles(root, join(root, "out-a"), ["small", "full"]);
    const b = buildZipBundles(root, join(root, "out-b"), ["small", "full"]);
    expect(a.tag).toBe("build-42");
    expect(a.files.map((f) => f.name)).toEqual([zipName("42", "small"), zipName("42", "full")]);
    expect(a.files.map((f) => f.sha256)).toEqual(b.files.map((f) => f.sha256));
    const sum = readFileSync(join(root, "out-a", `${zipName("42", "small")}.sha256`), "utf8");
    expect(sum).toBe(`${a.files[0]!.sha256}  ${zipName("42", "small")}\n`);
    expect(readFileSync(join(root, "out-a", "RELEASE-NOTES.md"), "utf8")).toContain("game build 42");
  });

  it("builds only the small zip when asked, without needing assets", () => {
    const noAssets = mkdtempSync(join(tmpdir(), "wardogs-bundle-"));
    put(join(noAssets, "data/MANIFEST.json"), JSON.stringify({ provenance: { gameBuild: "9" } }));
    put(join(noAssets, "data/items.json"), "{}");
    const built = buildZipBundles(noAssets, join(noAssets, "out"), ["small"]);
    expect(built.files.map((f) => f.kind)).toEqual(["small"]);
    expect(() => bundleEntries(noAssets, "9", "full")).toThrow(/assets/);
  });

  it("sizes the full zip from the manifests, so notes built where the images are absent still say how big it is", () => {
    const root = mkdtempSync(join(tmpdir(), "wardogs-bundle-"));
    const MB = 1024 * 1024;
    put(join(root, "data/MANIFEST.json"), JSON.stringify({ provenance: { gameBuild: "5" } }));
    put(join(root, "data/items.json"), "{}");
    put(join(root, "assets/icons.manifest.json"), JSON.stringify({ files: [{ path: "a.png", bytes: 20 * MB }] }));
    put(join(root, "assets/maps.manifest.json"), JSON.stringify({ worlds: { w: { files: [{ path: "t.webp", bytes: 300 * MB }], heightmap: { path: "h.png", bytes: 80 * MB } } } }));
    expect(imageBytes(root)).toBe(400 * MB);
    const notes = bundleNotes(root, "5");
    expect(notes).toMatch(/-full\.zip` \| 400 MB unpacked/);
    expect(notes).not.toMatch(/\b[0-9] MB unpacked \| Everything/);
  });

  it("describes both archives in the notes, and says what the project is", () => {
    const notes = bundleNotes(makeRoot(), "42");
    expect(notes).toContain(zipName("42", "small"));
    expect(notes).toContain(zipName("42", "full"));
    expect(notes).toContain("Unlicense");
    expect(notes).toContain("not affiliated");
  });
});

describe("static site", () => {
  it("serves every data file under /v1/ with the same path, plus an index with checksums", () => {
    const root = makeRoot();
    const out = join(root, "site");
    const { files } = buildSite(root, out);
    expect(files.map((f) => f.path)).toEqual(["MANIFEST.json", "README.md", "items.json", "maps/w1/map.json"]);
    expect(readFileSync(join(out, API_VERSION, "items.json"), "utf8")).toBe(readFileSync(join(root, "data/items.json"), "utf8"));
    const index = JSON.parse(readFileSync(join(out, API_VERSION, "index.json"), "utf8")) as { gameBuild: string; files: Array<{ path: string; type: string }> };
    expect(index.gameBuild).toBe("42");
    expect(index.files.find((f) => f.path === "maps/w1/map.json")!.type).toBe("json");
    expect(siteMatchesIndex(out)).toBe(true);
  });

  it("serves no images and nothing from assets/", () => {
    const root = makeRoot();
    const out = join(root, "site");
    const { files } = buildSite(root, out);
    expect(files.some((f) => /\.(png|webp)$/.test(f.path))).toBe(false);
    expect(readFileSync(join(out, "index.html"), "utf8")).not.toContain("assets/");
  });

  it("has a landing page, a 404 page and no Jekyll step", () => {
    const root = makeRoot();
    const out = join(root, "site");
    buildSite(root, out);
    expect(readFileSync(join(out, "index.html"), "utf8")).toContain('href="v1/items.json"');
    expect(readFileSync(join(out, "404.html"), "utf8")).toContain("Not found");
    expect(readFileSync(join(out, ".nojekyll"), "utf8")).toBe("");
  });

  it("escapes file names in the landing page", () => {
    expect(landingPage("1", [{ path: "a<b>&.json", bytes: 1, sha256: "x" }])).toContain("a&lt;b&gt;&amp;.json");
  });
});
