import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { diffAgainstHead } from "../src/diffCommand.js";
import { diffFile, diffRecords, flatten, formatRecordDiff, isEmptyRecordDiff, NOT_RECORDS, RECORD_SETS, recordSetFor, undeclaredSchemas } from "../src/changes.js";
import { PUBLISHED } from "../src/derived/schemas.js";

const byId = { key: (r: any) => r.id, label: (r: any) => `${r.name ?? r.id} (${r.id})` };

describe("flatten", () => {
  it("makes dotted paths of nested objects and keeps arrays whole", () => {
    expect([...flatten({ a: 1, b: { c: 2, d: { e: [1, 2] } } })]).toEqual([["a", 1], ["b.c", 2], ["b.d.e", [1, 2]]]);
  });
});

describe("diffRecords", () => {
  const before = [{ id: "a", name: "Alpha", stats: { dmg: 10, tags: ["x"] } }, { id: "b", name: "Beta" }];

  it("reports nothing for identical data", () => {
    expect(isEmptyRecordDiff(diffRecords(before, structuredClone(before), byId))).toBe(true);
  });

  it("finds added, removed and changed records, and the changed field's path and values", () => {
    const after = [{ id: "a", name: "Alpha", stats: { dmg: 12, tags: ["x", "y"] } }, { id: "c", name: "Gamma" }];
    const d = diffRecords(before, after, byId);
    expect(d.added).toEqual([{ key: "c", label: "Gamma (c)" }]);
    expect(d.removed).toEqual([{ key: "b", label: "Beta (b)" }]);
    expect(d.changed).toEqual([
      { key: "a", label: "Alpha (a)", fields: [{ path: "stats.dmg", before: 10, after: 12 }, { path: "stats.tags", before: ["x"], after: ["x", "y"] }] },
    ]);
  });

  it("sees a field that appeared or disappeared", () => {
    const d = diffRecords([{ id: "a", icon: "x.png" }], [{ id: "a", description: "d" }], byId);
    expect(d.changed[0]!.fields).toEqual([{ path: "icon", before: "x.png", after: undefined }, { path: "description", before: undefined, after: "d" }]);
  });

  it("keeps records that share a key apart, in order", () => {
    const a = [{ id: "r", n: 1 }, { id: "r", n: 2 }];
    const b = [{ id: "r", n: 1 }, { id: "r", n: 3 }];
    const d = diffRecords(a, b, byId);
    expect(d.changed.map((c) => [c.key, c.fields[0]!.path])).toEqual([["r#2", "n"]]);
    expect(isEmptyRecordDiff(diffRecords(a, a, byId))).toBe(true);
  });
});

describe("formatRecordDiff", () => {
  it("renders sections with counts and the field change, and nothing for an empty diff", () => {
    const d = diffRecords([{ id: "a", v: 1 }], [{ id: "a", v: 2 }, { id: "b", v: 1 }], byId);
    const md = formatRecordDiff("data/x.json", d).join("\n");
    expect(md).toContain("### data/x.json");
    expect(md).toContain("1 added, 0 removed, 1 changed.");
    expect(md).toContain("- a (a): v `1` -> `2`");
    expect(formatRecordDiff("x", { added: [], removed: [], changed: [] })).toEqual([]);
  });

  it("cuts long sections and says how many were left out, and shortens long values", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: `n${i}` }));
    expect(formatRecordDiff("x", diffRecords([], many, byId), 2).join("\n")).toContain("... and 3 more");
    const long = formatRecordDiff("x", diffRecords([{ id: "a", t: "a".repeat(300) }], [{ id: "a", t: "b".repeat(300) }], byId)).join("\n");
    expect(long).toContain("...");
    expect(long.length).toBeLessThan(500);
  });
});

describe("declared record sets", () => {
  it("covers every published file type: a record set, or a deliberate entry in NOT_RECORDS", () => {
    expect(undeclaredSchemas()).toEqual([]);
  });

  it("refers only to schemas that exist", () => {
    const names = new Set(PUBLISHED.map((p) => p.name));
    for (const s of RECORD_SETS) expect(names.has(s.schema), s.schema).toBe(true);
    for (const n of NOT_RECORDS) expect(names.has(n), n).toBe(true);
  });

  it("finds the set for a path, with the world for per-world files", () => {
    expect(recordSetFor("data/weapons.json")?.set.schema).toBe("weapons");
    expect(recordSetFor("data/maps/kavkazi/objects.json")).toMatchObject({ world: "kavkazi", set: { schema: "objects" } });
    expect(recordSetFor("data/maps/kavkazi/map.json")).toBeUndefined();
  });

  it("keys the real files so that no two records collide, apart from the game's repeated rules", () => {
    for (const set of RECORD_SETS) {
      if (typeof set.path !== "string") continue;
      const json = JSON.parse(readFileSync(set.path, "utf8")) as Record<string, unknown>;
      const keys = set.records(json).map(set.key);
      const duplicates = keys.length - new Set(keys).size;
      // The damage model repeats some rules (the ghillie suit lists its rules twice); everything else is unique.
      if (set.schema !== "damage") expect(duplicates, set.schema).toBe(0);
    }
  });
});

describe("diffFile", () => {
  it("diffs a record file through its record set", () => {
    const before = { items: [{ id: "A", name: "Alpha", maxStack: 1 }] };
    const after = { items: [{ id: "A", name: "Alpha", maxStack: 5 }] };
    const r = diffFile("data/items.json", before, after);
    expect(r.empty).toBe(false);
    expect(r.lines.join("\n")).toContain("maxStack `1` -> `5`");
  });

  it("is empty when only the build id changed, and compares whole-file schemas as one record", () => {
    expect(diffFile("data/items.json", { gameBuild: "1", items: [] }, { gameBuild: "2", items: [] }).empty).toBe(true);
    const r = diffFile("data/maps/w/map.json", { bounds: { min: [0, 0] } }, { bounds: { min: [0, 5] } });
    expect(r.empty).toBe(false);
    expect(r.lines.join("\n")).toContain("bounds.min");
  });
});

describe("diffAgainstHead (in a real git repository)", () => {
  const put = (root: string, path: string, value: unknown) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(value));
  };
  const git = (root: string, ...args: string[]) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8" });
  const repo = () => {
    const root = mkdtempSync(join(tmpdir(), "wardogs-diff-"));
    git(root, "init", "-q");
    put(root, "data/items.json", { gameBuild: "1", items: [{ id: "A", name: "Alpha", maxStack: 1 }, { id: "B", name: "Beta", maxStack: 1 }] });
    put(root, "data/weapons.json", { gameBuild: "1", weapons: [{ id: "A", rpm: 600 }] });
    put(root, "data/csv/ignored.json", { x: 1 });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "first");
    return root;
  };

  it("says there is nothing to compare with before the first commit", () => {
    const root = mkdtempSync(join(tmpdir(), "wardogs-nocommit-"));
    git(root, "init", "-q");
    put(root, "data/items.json", { items: [] });
    expect(diffAgainstHead(root)).toBeNull();
  });

  it("reports no changes for a clean tree", () => {
    expect(diffAgainstHead(repo())).toContain("No changes.");
  });

  it("reports added, removed and changed records across files, with both build ids", () => {
    const root = repo();
    put(root, "data/items.json", { gameBuild: "2", items: [{ id: "A", name: "Alpha", maxStack: 5 }, { id: "C", name: "Gamma", maxStack: 1 }] });
    put(root, "data/weapons.json", { gameBuild: "2", weapons: [{ id: "A", rpm: 650 }] });
    put(root, "data/ammo.json", { gameBuild: "2", projectiles: [] });
    const report = diffAgainstHead(root)!;
    expect(report).toContain("build 1 -> 2");
    expect(report).toContain("### data/items.json");
    expect(report).toContain("1 added, 1 removed, 1 changed.");
    expect(report).toContain("- Alpha (A): maxStack `1` -> `5`");
    expect(report).toContain("- Gamma (C)");
    expect(report).toContain("- Beta (B)");
    expect(report).toContain("- A: rpm `600` -> `650`");
    expect(report).toContain("### data/ammo.json\n\nNew file.");
  });

  it("leaves out a file where only the build id changed, and notes a removed file", () => {
    const root = repo();
    put(root, "data/items.json", { gameBuild: "2", items: [{ id: "A", name: "Alpha", maxStack: 1 }, { id: "B", name: "Beta", maxStack: 1 }] });
    spawnSync("rm", [join(root, "data/weapons.json")]);
    const report = diffAgainstHead(root)!;
    expect(report).not.toContain("### data/items.json");
    expect(report).toContain("### data/weapons.json\n\nRemoved.");
  });
});
