import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withCompleteness } from "./derived/completeness.js";

/** Rewrites the completeness table in `README.md` from `src/derived/completeness.ts`. Returns true when the file changed. */
export function syncReadme(root: string): boolean {
  const file = join(root, "README.md");
  const before = readFileSync(file, "utf8");
  const after = withCompleteness(before);
  if (after === before) return false;
  writeFileSync(file, after);
  return true;
}
