import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { buildCsvTables, csvCell, list, toCsv } from "../src/derived/csv.js";
import { buildDictionary } from "../src/derived/dictionary.js";
import { deriveFiles } from "../src/derived/index.js";
import { fieldDocs, jsonSchemaFor, PUBLISHED, typeName } from "../src/derived/schemas.js";
import type { GeneratedFile } from "../src/generated.js";

describe("csvCell and toCsv", () => {
  it("leaves plain text alone and writes absent values as empty", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(false)).toBe("false");
  });

  it("quotes delimiters, quotes and line breaks (RFC 4180)", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell("cr\rlf")).toBe('"cr\rlf"');
  });

  it("writes a header and one line per row, ending with a newline", () => {
    const rows = [{ a: 1, b: "x,y" }, { a: 2, b: undefined }];
    const csv = toCsv([{ name: "a", about: "", value: (r: (typeof rows)[number]) => r.a }, { name: "b", about: "", value: (r) => r.b }], rows);
    expect(csv).toBe('a,b\n1,"x,y"\n2,\n');
  });

  it("joins lists with semicolons and leaves empty lists empty", () => {
    expect(list(["a", "b"])).toBe("a;b");
    expect(list([])).toBeUndefined();
  });
});

describe("typeName and fieldDocs", () => {
  it("names common shapes", () => {
    expect(typeName({ type: "string" })).toBe("string");
    expect(typeName({ const: 1 })).toBe("1");
    expect(typeName({ enum: ["a", "b"] })).toBe('"a" | "b"');
    expect(typeName({ type: "array", items: { type: "string" } })).toBe("list of string");
    expect(typeName({ type: "array", prefixItems: [{ type: "number" }, { type: "number" }], items: false })).toBe("[number, number]");
    expect(typeName({ anyOf: [{ type: "object" }, { type: "null" }] })).toBe("object or null");
  });

  it("flattens nested objects and lists, in order, with required flags", () => {
    const rows = fieldDocs({
      type: "object",
      required: ["list"],
      properties: {
        list: { type: "array", description: "Things.", items: { type: "object", required: ["id"], properties: { id: { type: "string", description: "Id." }, note: { type: "string" } } } },
        one: { type: "object", description: "One.", properties: { x: { type: "number", description: "X." } } },
      },
    });
    expect(rows.map((r) => [r.path, r.required])).toEqual([
      ["list", true],
      ["list[].id", true],
      ["list[].note", false],
      ["one", false],
      ["one.x", false],
    ]);
    expect(rows.find((r) => r.path === "list[].id")?.description).toBe("Id.");
  });
});

describe("published schemas", () => {
  it("documents every file type and every field, so the dictionary has no blanks", () => {
    for (const entry of PUBLISHED) {
      const schema = jsonSchemaFor(entry) as { description?: string; title: string };
      expect(schema.description, `${entry.name} needs a description`).toBeTruthy();
      expect(schema.title).toBe(entry.title);
      const blank = fieldDocs(schema).filter((f) => !f.description).map((f) => f.path);
      expect(blank, `${entry.name} has undocumented fields`).toEqual([]);
    }
  });

  it("uses distinct names and non-overlapping paths", () => {
    expect(new Set(PUBLISHED.map((p) => p.name)).size).toBe(PUBLISHED.length);
    for (const a of PUBLISHED) for (const b of PUBLISHED) if (a !== b) expect(a.match.test("data/maps/x/" + b.name + ".json") && b.match.test("data/maps/x/" + b.name + ".json") && a.name !== b.name).toBe(false);
  });
});

/** Every file under data/ that a published schema covers must validate against the JSON Schema we generate for it. */
describe("generated JSON Schema validates the real data", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n).replaceAll("\\", "/")]));
  const files = walk("data");

  for (const entry of PUBLISHED) {
    it(`${entry.name}: every matching file validates`, () => {
      const matching = files.filter((f) => entry.match.test(f));
      expect(matching.length).toBeGreaterThan(0);
      const validate = new Ajv2020({ strict: false }).compile(jsonSchemaFor(entry));
      for (const f of matching) {
        const ok = validate(JSON.parse(readFileSync(f, "utf8")));
        expect(ok, `${f}: ${JSON.stringify(validate.errors?.slice(0, 3))}`).toBe(true);
      }
    });
  }

  it("rejects a file with a wrong type", () => {
    const entry = PUBLISHED.find((p) => p.name === "vehicles")!;
    const validate = new Ajv2020({ strict: false }).compile(jsonSchemaFor(entry));
    expect(validate({ schemaVersion: 1, gameBuild: "1", vehicles: [{ id: "V", asset: "A", maxSpeed: "fast" }] })).toBe(false);
  });

  it("checked-in schema files equal what the code generates", () => {
    for (const entry of PUBLISHED) expect(JSON.parse(readFileSync(`data/schema/${entry.name}.schema.json`, "utf8"))).toEqual(JSON.parse(JSON.stringify(jsonSchemaFor(entry))));
  });
});

describe("CSV tables", () => {
  const items = { schemaVersion: 1, gameBuild: "1", items: [
    { id: "Id.Item.A", kind: "item", asset: "A", name: "Alpha, the first", description: "- one\n- two", tags: ["T.A", "T.B"], grid: [2, 3], maxStack: 5, unlock: { role: "Medic", level: 9, cost: 25000 },
      vendor: [{ tag: "Id.Item.A", price: 600, amount: 10, categories: ["Vendor.Ammo"] }] },
    { id: "Id.Item.B", kind: "item", asset: "B", name: "Beta", tags: [], grid: [1, 1], maxStack: 1, unlock: null, vendor: [] },
  ] };
  const tables = buildCsvTables(new Map([["data/items.json", items]]));
  const byPath = (path: string) => tables.find((t) => t.path === path)!;

  it("builds the item and price tables, and skips tables whose source is absent", () => {
    expect(tables.map((t) => t.path)).toEqual(["data/csv/items.csv", "data/csv/prices.csv"]);
  });

  it("flattens grid, unlock and tags, and quotes text with commas and line breaks", () => {
    const lines = byPath("data/csv/items.csv").content.split("\n");
    expect(lines[0]).toBe("id,kind,name,subtitle,description,icon,developer,grid_width,grid_height,max_stack,weight,durability,unlock_role,unlock_level,unlock_cost,tags");
    expect(byPath("data/csv/items.csv").content).toContain('Id.Item.A,item,"Alpha, the first",,"- one\n- two",,,2,3,5,,,Medic,9,25000,T.A;T.B');
    expect(byPath("data/csv/items.csv").content).toContain("Id.Item.B,item,Beta,,,,,1,1,1,,,,,,");
  });

  it("computes the unit price of lots", () => {
    expect(byPath("data/csv/prices.csv").content).toContain("Id.Item.A,\"Alpha, the first\",Id.Item.A,600,10,60,Vendor.Ammo");
  });

  it("documents every column", () => {
    for (const t of tables) {
      expect(t.columns.length).toBeGreaterThan(0);
      for (const c of t.columns) expect(c.about, `${t.path} ${c.name}`).toBeTruthy();
      expect(t.content.split("\n")[0]).toBe(t.columns.map((c) => c.name).join(","));
    }
  });
});

describe("real data: CSV tables", () => {
  const read = (path: string) => readFileSync(path, "utf8");
  const parseCsv = (text: string): string[][] => {
    const rows: string[][] = [[]];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!;
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") { rows.at(-1)!.push(cell); cell = ""; }
      else if (c === "\n") { rows.at(-1)!.push(cell); cell = ""; rows.push([]); }
      else cell += c;
    }
    rows.pop(); // the empty row after the final newline
    return rows;
  };

  it("has the same number of rows as the JSON it came from, and rectangular rows", () => {
    const items = JSON.parse(read("data/items.json")).items as unknown[];
    const rows = parseCsv(read("data/csv/items.csv"));
    expect(rows.length - 1).toBe(items.length);
    for (const r of rows) expect(r.length).toBe(rows[0]!.length);
    expect(parseCsv(read("data/csv/weapons.csv")).length - 1).toBe(JSON.parse(read("data/weapons.json")).weapons.length);
  });

  it("round-trips a value with commas and newlines: the AK74 description", () => {
    const rows = parseCsv(read("data/csv/items.csv"));
    const header = rows[0]!;
    const ak = rows.find((r) => r[0] === "Id.Item.AK74M")!;
    expect(ak[header.indexOf("description")]).toBe("- Semi / Full Auto\n- 5.45x39mm");
    expect(ak[header.indexOf("grid_width")]).toBe("5");
  });
});

describe("real data: name columns and the weapon damage sheet", () => {
  const lines = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean);

  it("adds display names next to ids", () => {
    expect(lines("data/csv/weapons.csv").find((l) => l.startsWith("Id.Item.AK74M,"))).toMatch(/^Id\.Item\.AK74M,AK74,/);
    expect(lines("data/csv/vehicles.csv").find((l) => l.includes("Havoc.Default,"))).toMatch(/,Havoc,/);
    expect(lines("data/csv/loot-items.csv").some((l) => /,Bandage,/.test(l))).toBe(true);
  });

  it("computes damage and raw damage per second per weapon and projectile", () => {
    const rows = lines("data/csv/weapon-damage.csv");
    expect(rows[0]).toBe("weapon_id,weapon_name,projectile,projectile_items,damage_per_hit,rpm,raw_dps,muzzle_velocity_mps,effective_range_m,full_damage_range_m");
    const ak = rows.find((l) => l.startsWith("Id.Item.AK74M,"))!;
    // AK74M: 26 damage at 650 rpm = 281.67 per second, full damage out to 500 m.
    expect(ak).toMatch(/,Item\.Caliber\.545mm,.*,26,650,281\.67,880,500,500$/);
  });

  it("skips projectiles no ammo item fires, and covers a weapon's sub-calibers", () => {
    const rows = lines("data/csv/weapon-damage.csv");
    expect(rows.some((l) => l.includes("DebugHoming"))).toBe(false);
    expect(rows.filter((l) => l.startsWith("Id.Item.M500,")).length).toBeGreaterThanOrEqual(2); // 12g and 7mm buckshot, and the slug
  });
});

describe("data dictionary", () => {
  const paths = ["data/items.json", "data/weapons.json", "data/maps/a/map.json", "data/maps/a/buildings.geojson"];
  const tables = buildCsvTables(new Map());

  it("lists every file and every field of a present schema, and is deterministic", () => {
    const text = buildDictionary(paths, tables, "42");
    expect(text).toContain("Game build 42");
    expect(text).toContain("`data/items.json`");
    expect(text).toContain("`items[].grid`");
    expect(text).toContain("`data/maps/a/buildings.geojson`");
    expect(text).not.toContain("## Ammunition ballistics"); // no ammo file in this set
    expect(buildDictionary(paths, tables, "42")).toBe(text);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("deriveFiles produces schemas, CSV, and the dictionary from the data files", () => {
    const real = ["data/items.json", "data/ammo.json", "data/weapons.json", "data/attachments.json", "data/vehicles.json"].map((path): GeneratedFile => ({ path, content: readFileSync(path, "utf8") }));
    const derived = deriveFiles(real);
    const paths2 = derived.map((f) => f.path);
    expect(paths2).toContain("data/schema/items.schema.json");
    expect(paths2).toContain("data/csv/weapons.csv");
    expect(paths2).toContain("data/README.md");
    expect(paths2).not.toContain("data/schema/map.schema.json"); // no map files given
    expect(deriveFiles(real)).toEqual(derived);
  });
});
