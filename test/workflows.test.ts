import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const publish = readFileSync(".github/workflows/publish.yml", "utf8");
const scripts = Object.keys(JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>);

/** The text of one top-level job in the workflow. */
function job(name: string): string {
  const start = publish.indexOf(`\n  ${name}:\n`);
  expect(start, `job ${name}`).toBeGreaterThan(-1);
  const rest = publish.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe("publish workflow", () => {
  it("runs only for build tags", () => {
    expect(publish).toMatch(/on:\s+push:\s+tags: \["build-\*"\]/);
    expect(publish).not.toMatch(/branches:/);
    expect(publish).not.toMatch(/workflow_dispatch|pull_request|schedule/);
  });

  it("only runs pnpm scripts that exist", () => {
    const builtin = new Set(["install"]);
    const used = [...publish.matchAll(/run: pnpm ([a-z:-]+)/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(3);
    for (const name of used) expect(builtin.has(name) || scripts.includes(name), `pnpm ${name}`).toBe(true);
  });

  it("builds only what is in git: the small zip and the site, with no Git LFS", () => {
    expect(publish).not.toContain("lfs");
    expect(publish).not.toContain("  full:");
    expect(job("small")).toContain("pnpm bundle --small");
    expect(readFileSync(".github/workflows/ci.yml", "utf8")).not.toContain("lfs");
  });

  it("creates the release with the small zip", () => {
    expect(job("small")).toContain("gh release create");
  });

  it("deploys the folder that `pnpm site` builds, and no images", () => {
    expect(job("pages")).toContain("path: dist/site");
    expect(job("pages")).toContain("pages: write");
    expect(readFileSync("src/cli.ts", "utf8")).toContain('join(root, "dist", "site")');
  });

  it("grants write access only to the jobs that publish", () => {
    expect(publish.split("contents: write").length - 1).toBe(1);
    expect(publish.split("pages: write").length - 1).toBe(1);
  });
});
