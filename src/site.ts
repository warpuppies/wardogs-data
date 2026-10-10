import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readBuild } from "./bundle.js";
import { walk } from "./generated.js";
import { hashFile } from "./maps/tiles.js";

/** Version of the URL layout. Files are served under `/v1/`, with the same paths as under `data/`. */
export const API_VERSION = "v1";

export interface SiteFile {
  /** Path under `/v1/`, the same as the path under `data/`. */
  path: string;
  bytes: number;
  sha256: string;
}

const contentType = (path: string): string => (path.endsWith(".json") || path.endsWith(".geojson") ? "json" : path.endsWith(".csv") ? "csv" : path.endsWith(".md") ? "markdown" : "other");

const escapeHtml = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** The landing page: what the site is, how to fetch, and every file. Plain HTML, no scripts. */
export function landingPage(build: string, files: readonly SiteFile[]): string {
  const rows = files.map((f) => `<tr><td><a href="${API_VERSION}/${escapeHtml(f.path)}">${escapeHtml(f.path)}</a></td><td>${f.bytes}</td></tr>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wardogs data</title>
<style>
:root { color-scheme: light dark; }
body { font: 16px/1.5 system-ui, sans-serif; max-width: 52rem; margin: 2rem auto; padding: 0 1rem; }
code, pre { font-family: ui-monospace, monospace; }
pre { overflow-x: auto; padding: 0.75rem; background: color-mix(in srgb, currentColor 8%, transparent); }
table { border-collapse: collapse; width: 100%; }
td, th { text-align: left; padding: 0.15rem 0.5rem; border-bottom: 1px solid color-mix(in srgb, currentColor 20%, transparent); }
td:last-child, th:last-child { text-align: right; }
</style>
</head>
<body>
<h1>Wardogs data</h1>
<p>Structured game data for game build ${escapeHtml(build)}, as static files. Unofficial project, not affiliated with the game's developer or publisher. Released under the Unlicense. Images (item icons, map tiles) are not served here; they are in the release archives.</p>
<p><a href="${API_VERSION}/index.json">${API_VERSION}/index.json</a> lists every file with its size and checksum. <a href="${API_VERSION}/README.md">${API_VERSION}/README.md</a> is the data dictionary, with what is complete and what is missing.</p>
<pre>fetch("${API_VERSION}/items.json").then((r) =&gt; r.json()).then((d) =&gt; console.log(d.gameBuild, d.items.length));</pre>
<table>
<thead><tr><th>File</th><th>Bytes</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>
`;
}

const NOT_FOUND = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Not found</title></head>
<body><h1>Not found</h1><p>See the <a href="./">list of files</a>.</p></body></html>
`;

/**
 * Builds the static site into `outDir` (cleared first): every file under `data/` served at `/v1/<path under data>`, an
 * `index.json` that lists them with checksums, a landing page and a 404 page. No images and nothing outside `data/`.
 * It is a plain folder, so any static host can serve it; GitHub Pages is what CI uses.
 */
export function buildSite(root: string, outDir: string): { build: string; files: SiteFile[] } {
  const build = readBuild(root);
  rmSync(outDir, { recursive: true, force: true });
  const files: SiteFile[] = [];
  for (const rel of walk(join(root, "data"), join(root, "data"))) {
    const dest = join(outDir, API_VERSION, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(root, "data", rel), dest);
    files.push({ path: rel, bytes: statSync(dest).size, sha256: hashFile(dest) });
  }
  const index = {
    schemaVersion: 1,
    gameBuild: build,
    license: "Unlicense",
    unofficial: true,
    about: "Static files for one game build. Images are not served; they are in the release archives.",
    files: files.map((f) => ({ ...f, type: contentType(f.path) })),
  };
  writeFileSync(join(outDir, API_VERSION, "index.json"), JSON.stringify(index, null, 2) + "\n");
  writeFileSync(join(outDir, "index.html"), landingPage(build, files));
  writeFileSync(join(outDir, "404.html"), NOT_FOUND);
  // Serve the files as they are, without the Jekyll step.
  writeFileSync(join(outDir, ".nojekyll"), "");
  return { build, files };
}

/** True when `index.json` of a built site describes exactly the files on disk. Used by tests. */
export function siteMatchesIndex(outDir: string): boolean {
  const index = JSON.parse(readFileSync(join(outDir, API_VERSION, "index.json"), "utf8")) as { files: SiteFile[] };
  return index.files.every((f) => hashFile(join(outDir, API_VERSION, f.path)) === f.sha256);
}
