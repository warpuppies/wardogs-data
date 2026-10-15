import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PackageIndex } from "../src/transform/packages.js";

describe("PackageIndex.findAll", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "package-index-"));
    const dir = join(root, "Wardogs", "Content", "Data");
    mkdirSync(dir, { recursive: true });
    const write = (name: string, exports: unknown[]) => writeFileSync(join(dir, name), JSON.stringify(exports, null, 2));
    write("DA_One.json", [{ Type: "WDThingDataAsset", Name: "One" }, { Type: "Other", Name: "x" }]);
    write("DA_Two.json", [{ Type: "WDThingDataAsset", Name: "Two" }]);
    write("DT_Table.json", [{ Type: "DataTable", Name: "Table" }]);
    // A type that only appears as a value is not an export of that type.
    write("DA_Three.json", [{ Type: "Other", Name: "WDThingDataAsset" }]);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const names = (found: Array<{ export: { Name?: string } }>) => found.map((f) => f.export.Name);

  it("finds the exports of one type, in the order of their packages", () => {
    const index = new PackageIndex([root]);
    expect(names([...index.findAll("WDThingDataAsset")])).toEqual(["One", "Two"]);
    expect(names([...index.findAll("DataTable")])).toEqual(["Table"]);
    expect([...index.findAll("Missing")]).toEqual([]);
  });

  it("matches a pattern against the type names, and only in files with the right name prefix", () => {
    const index = new PackageIndex([root]);
    expect(names([...index.findAll(/^WDThing/)])).toEqual(["One", "Two"]);
    expect(names([...index.findAll("WDThingDataAsset", "DA_T")])).toEqual(["Two"]);
  });

  it("answers repeated questions the same way", () => {
    const index = new PackageIndex([root]);
    expect(names([...index.findAll("WDThingDataAsset")])).toEqual(names([...index.findAll("WDThingDataAsset")]));
  });
});
