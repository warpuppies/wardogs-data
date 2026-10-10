import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** A file the pipeline owns. `path` is relative to the repo root and uses forward slashes. */
export interface GeneratedFile {
  path: string;
  content: string;
}

export type PlanAction = "create" | "update" | "unchanged" | "delete";

export interface PlanEntry {
  path: string;
  action: PlanAction;
}

export function* walk(dir: string, base = dir): Generator<string> {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full, base);
    else yield full.slice(base.length + 1).split("\\").join("/");
  }
}

/**
 * Compares what the pipeline would write with what is on disk. Files under `ownedDirs` that the pipeline no longer
 * produces are reported as `delete`, so stale outputs cannot linger. Nothing is written.
 */
export function planFiles(root: string, files: readonly GeneratedFile[], ownedDirs: readonly string[]): PlanEntry[] {
  const wanted = new Map(files.map((f) => [f.path, f.content]));
  const entries: PlanEntry[] = [];
  for (const [path, content] of [...wanted].sort(([a], [b]) => a.localeCompare(b))) {
    const full = join(root, path);
    if (!existsSync(full)) entries.push({ path, action: "create" });
    else entries.push({ path, action: readFileSync(full, "utf8") === content ? "unchanged" : "update" });
  }
  for (const dir of ownedDirs) {
    for (const rel of walk(join(root, dir), root)) {
      if (!wanted.has(rel)) entries.push({ path: rel, action: "delete" });
    }
  }
  return entries;
}

/** Writes the plan to disk: creates and updates files, deletes stale ones. */
export function applyFiles(root: string, files: readonly GeneratedFile[], plan: readonly PlanEntry[]): void {
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  for (const entry of plan) {
    const full = join(root, entry.path);
    if (entry.action === "delete") rmSync(full, { force: true });
    else if (entry.action !== "unchanged") {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, byPath.get(entry.path) ?? "");
    }
  }
}

export const hasChanges = (plan: readonly PlanEntry[]): boolean => plan.some((e) => e.action !== "unchanged");

export function formatPlan(plan: readonly PlanEntry[]): string {
  const symbol: Record<PlanAction, string> = { create: "+", update: "~", delete: "-", unchanged: " " };
  const changed = plan.filter((e) => e.action !== "unchanged");
  if (changed.length === 0) return `No changes. ${plan.length} files match the pipeline output.`;
  const counts = (a: PlanAction) => plan.filter((e) => e.action === a).length;
  return [
    ...changed.map((e) => `${symbol[e.action]} ${e.path}`),
    `Plan: ${counts("create")} to create, ${counts("update")} to update, ${counts("delete")} to delete, ${counts("unchanged")} unchanged.`,
  ].join("\n");
}
