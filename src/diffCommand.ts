import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { diffFile } from "./changes.js";
import { listDataFiles } from "./pipeline.js";

/** Data files worth diffing: the JSON the pipeline writes, not the schemas, CSV copies or the manifest. */
const isDiffable = (path: string): boolean => /^data\/(?!schema\/|csv\/|MANIFEST).*\.json$/.test(path);

const git = (root: string, args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/** The JSON data files as of the last commit, by path, or null when there is no commit to compare with. */
export function committedFiles(root: string): Map<string, string> | null {
  const tree = git(root, ["ls-tree", "-r", "--name-only", "HEAD", "data"]);
  if (tree.status !== 0) return null;
  const files = new Map<string, string>();
  for (const path of tree.stdout.split("\n").filter(isDiffable)) {
    const show = git(root, ["show", `HEAD:${path}`]);
    if (show.status === 0) files.set(path, show.stdout);
  }
  return files;
}

const buildOf = (files: ReadonlyMap<string, string>): string => {
  const items = files.get("data/items.json");
  return (items ? (JSON.parse(items) as { gameBuild?: string }).gameBuild : undefined) ?? "none";
};

/**
 * Markdown report of how `data/` differs from the last commit: records added, removed and changed in every JSON file.
 * Returns null when there is no commit yet. Files that changed only in their build id or formatting are not listed.
 */
export function diffAgainstHead(root: string): string | null {
  const committed = committedFiles(root);
  if (!committed) return null;
  const current = new Map(listDataFiles(root).filter(isDiffable).map((p) => [p, readFileSync(join(root, p), "utf8")]));
  const out = [`## Data changes: build ${buildOf(committed)} -> ${buildOf(current)}`, ""];
  let reported = 0;
  for (const path of [...new Set([...committed.keys(), ...current.keys()])].sort()) {
    const before = committed.get(path);
    const after = current.get(path);
    if (before === after) continue;
    if (before === undefined) out.push(`### ${path}`, "", "New file.", "");
    else if (after === undefined) out.push(`### ${path}`, "", "Removed.", "");
    else {
      const result = diffFile(path, JSON.parse(before), JSON.parse(after));
      if (result.empty) continue;
      out.push(...result.lines);
    }
    reported++;
  }
  return (reported ? out : [...out, "No changes.", ""]).join("\n");
}
