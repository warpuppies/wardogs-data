import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DATASETS } from "../src/datasets/index.js";
import { COMPLETENESS, withCompleteness } from "../src/derived/completeness.js";
import { PUBLISHED } from "../src/derived/schemas.js";

const readme = readFileSync("README.md", "utf8");
const developing = readFileSync("DEVELOPING.md", "utf8");

describe("DEVELOPING.md", () => {
  it("documents every pnpm script", () => {
    const scripts = Object.keys(JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>);
    // Scripts that only shorten other documented commands.
    const internal = new Set(["typecheck", "test", "test:watch", "setup:extractor", "update-data", "check"]);
    const missing = scripts.filter((s) => !internal.has(s) && !developing.includes(`pnpm ${s}`) && !developing.includes(`\`pnpm ${s.replace(":", " ")}`));
    expect(missing).toEqual([]);
    for (const s of ["typecheck", "test", "setup:extractor", "update-data", "check"]) expect(developing, s).toContain(s === "typecheck" || s === "test" ? "Typecheck" : `pnpm ${s}`);
  });

  it("lists every dataset that `pnpm extract` accepts", () => {
    for (const d of DATASETS) expect(developing, `dataset ${d.id}`).toContain(`\`${d.id}\``);
  });

});

describe("README", () => {
  it("points at every published data file", () => {
    for (const entry of PUBLISHED) {
      // Per-world files are described by a pattern in the README, single files by name.
      const probe = entry.match.source.includes("maps") ? `${entry.name === "map" ? "map" : entry.name}.json` : `data/${entry.name}.json`;
      expect(readme, entry.name).toContain(probe);
    }
  });

  it("links to the generated data dictionary", () => {
    expect(readme).toContain("data/README.md");
  });

  it("has a current completeness table", () => {
    expect(withCompleteness(readme)).toBe(readme);
  });

  it("names only files that exist in the completeness table", () => {
    for (const area of COMPLETENESS) {
      for (const file of area.files) {
        const probe = file.replace("<world>", "kavkazi");
        expect(existsSync(join("data", probe)), `${area.area}: data/${probe}`).toBe(true);
      }
    }
  });

  it("lists every export of the public helpers", () => {
    const names = [...readFileSync("src/lib/index.ts", "utf8").matchAll(/^export \{([^}]+)\} from/gm)].flatMap((m) => m[1]!.split(",").map((n) => n.trim()).filter(Boolean));
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) expect(readme, `helper ${name}`).toContain(`\`${name}\``);
  });

  it("only links to files that exist", () => {
    for (const m of readme.matchAll(/\]\(([^)#]+)\)/g)) {
      const target = m[1]!;
      if (/^[a-z]+:/.test(target)) continue;
      expect(existsSync(target), target).toBe(true);
    }
  });
});
