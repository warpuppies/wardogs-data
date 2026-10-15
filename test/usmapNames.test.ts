import { zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseUsmapHeader, parseUsmapSchema, readUsmap, serializeSchema, writeUsmap } from "../src/extract/usmap.js";
import { isScrambled, restoreNames, restoreUsmap, scrambledShare } from "../src/extract/usmapNames.js";

type Prop = [name: string, type: number | { struct: string } | { array: number | { struct: string } }];
interface Spec {
  enums?: Array<[string, string[]]>;
  structs: Array<[string, Prop[]]>;
}

/** Builds a version 4 mappings file with a name table, enums and structs, uncompressed or ZStandard compressed. */
function usmap(spec: Spec, compression: 0 | 3 = 0): Buffer {
  const names: string[] = [];
  const nameIndex = (n: string): Buffer => {
    if (!names.includes(n)) names.push(n);
    const b = Buffer.alloc(4);
    b.writeInt32LE(names.indexOf(n));
    return b;
  };
  const u16 = (n: number): Buffer => Buffer.from([n & 255, n >> 8]);
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const body: Buffer[] = [u32(spec.enums?.length ?? 0)];
  for (const [name, values] of spec.enums ?? []) {
    body.push(nameIndex(name), u16(values.length));
    values.forEach((v, i) => body.push(Buffer.concat([Buffer.alloc(8, 0).fill(i, 0, 1), nameIndex(v)])));
  }
  body.push(u32(spec.structs.length));
  for (const [name, props] of spec.structs) {
    body.push(nameIndex(name), Buffer.from([255, 255, 255, 255]), u16(props.length), u16(props.length));
    props.forEach(([propName, type], index) => {
      body.push(u16(index), Buffer.from([1]), nameIndex(propName));
      const single = (t: number | { struct: string }): Buffer => (typeof t === "number" ? Buffer.from([t]) : Buffer.concat([Buffer.from([9]), nameIndex(t.struct)]));
      body.push(typeof type === "object" && "array" in type ? Buffer.concat([Buffer.from([8]), single((type as { array: number | { struct: string } }).array)]) : single(type as number | { struct: string }));
    });
  }
  // The name table comes first in the file but is only complete once the rest is built.
  const table = [u32(names.length), ...names.map((n) => Buffer.concat([u16(n.length), Buffer.from(n, "latin1")]))];
  const payload = Buffer.concat([...table, ...body]);
  const packed = compression === 3 ? zstdCompressSync(payload) : payload;
  const head = Buffer.from([0xc4, 0x30, 4, 0, 0, 0, 0, compression]);
  return Buffer.concat([head, u32(packed.length), u32(payload.length), packed]);
}

const FLOAT = 3;
const INT = 2;
const NAME = 5;
const UNKNOWN = 255;

describe("parseUsmapHeader", () => {
  it("reads the compression method after the versioning flag", () => {
    expect(parseUsmapHeader(usmap({ structs: [] }, 3))).toEqual({ version: 4, compression: 3 });
    expect(parseUsmapHeader(usmap({ structs: [] }, 0))).toEqual({ version: 4, compression: 0 });
  });

  it("skips the engine versions of a versioned file", () => {
    const head = Buffer.concat([Buffer.from([0xc4, 0x30, 4, 1, 0, 0, 0]), Buffer.alloc(8), Buffer.from([1, 0, 0, 0]), Buffer.alloc(20), Buffer.alloc(4), Buffer.from([3])]);
    expect(parseUsmapHeader(head)).toEqual({ version: 4, compression: 3 });
  });

  it("rejects other files", () => {
    expect(() => parseUsmapHeader(Uint8Array.from([0x50, 0x4b, 3, 4]))).toThrow(/usmap/);
    expect(() => parseUsmapHeader(new Uint8Array())).toThrow();
  });
});

describe("readUsmap and writeUsmap", () => {
  const spec: Spec = { structs: [["Thing", [["Count", INT]]]] };

  it("reads a ZStandard compressed body and writes it back uncompressed", () => {
    const file = readUsmap(usmap(spec, 3));
    expect(file.compression).toBe(3);
    const written = writeUsmap(file);
    expect(parseUsmapHeader(written)).toEqual({ version: 4, compression: 0 });
    expect(readUsmap(written).payload.equals(file.payload)).toBe(true);
    expect(parseUsmapSchema(readUsmap(written)).structs[0]).toMatchObject({ name: "Thing", properties: [{ index: 0, name: "Count", type: "Int" }] });
  });

  it("refuses a body it cannot decompress, and a file that is cut short", () => {
    const oodle = usmap(spec);
    oodle[7] = 1;
    expect(() => readUsmap(oodle)).toThrow(/Oodle/);
    expect(() => readUsmap(usmap(spec).subarray(0, 30))).toThrow(/cut short/);
  });

  it("reads enums, structs, and the types inside arrays", () => {
    const file = readUsmap(usmap({ enums: [["EKind", ["A", "B"]]], structs: [["S", [["Inner", { struct: "Other" }], ["Plain", FLOAT], ["Points", { array: { struct: "Point" } }], ["Lost", { array: UNKNOWN }]]]] }));
    const schema = parseUsmapSchema(file);
    expect(schema.enums).toEqual([{ name: "EKind", values: ["A", "B"] }]);
    expect(schema.structs[0]!.properties.map((p) => [p.name, p.type])).toEqual([["Inner", "Struct:Other"], ["Plain", "Float"], ["Points", "Array<Struct:Point>"], ["Lost", "Array<Unknown>"]]);
    // Writing what was read gives the same bytes.
    expect(serializeSchema(schema, schema.names, file.version).equals(file.payload)).toBe(true);
  });
});

describe("isScrambled", () => {
  it("tells the scrambled names from the real ones", () => {
    expect(isScrambled("_aaabiggnlpebjfhcidicc")).toBe(true);
    for (const real of ["ActivationID", "_aaa", "Float00_2", "bInstantAction"]) expect(isScrambled(real)).toBe(false);
  });
});

describe("restoreNames", () => {
  const old = usmap({
    enums: [["EKind", ["Alpha", "Beta"]]],
    structs: [
      ["Reward", [["Amount", FLOAT], ["Label", NAME], ["Count", INT]]],
      ["Other", [["Amount", FLOAT]]],
      ["Grown", [["Amount", FLOAT], ["Middle", INT], ["Label", NAME]]],
    ],
  });
  const schema = (file: Buffer) => parseUsmapSchema(readUsmap(file));
  const namesOf = (file: Buffer, struct: string) => schema(file).structs.find((s) => s.name === struct)!.properties.map((p) => p.name);

  it("names each scrambled property after the old property at its place, in every struct that uses the same text", () => {
    const now = usmap({
      enums: [["EKind", ["_aaaaaaaaaaaaaaaaaaaaa", "_aaaaaaaaaaaaaaaaaaaab"]]],
      structs: [
        ["Reward", [["_aaaaaaaaaaaaaaaaaaaac", FLOAT], ["_aaaaaaaaaaaaaaaaaaaad", NAME], ["_aaaaaaaaaaaaaaaaaaaae", INT]]],
        ["Other", [["_aaaaaaaaaaaaaaaaaaaac", FLOAT]]],
        ["Brand", [["_aaaaaaaaaaaaaaaaaaaaf", FLOAT]]],
      ],
    });
    const { names, report } = restoreNames(schema(now), schema(old));
    expect(names.filter((n) => !isScrambled(n))).toEqual(expect.arrayContaining(["Amount", "Label", "Count", "Alpha", "Beta"]));
    expect(report).toMatchObject({ scrambled: 6, restored: 5, conflicting: 0 });
    // A struct the old file does not have keeps its scrambled name.
    expect(report.stillScrambled).toBe(1);
  });

  it("anchors a struct that changed on the properties it still has, and names the ones between", () => {
    const now = usmap({
      structs: [
        ["Reward", [["_aaaaaaaaaaaaaaaaaaaac", FLOAT], ["_aaaaaaaaaaaaaaaaaaaad", NAME], ["_aaaaaaaaaaaaaaaaaaaae", INT]]],
        // `Grown` gained a property in front and one at the end. The old names of two properties are known from `Reward`,
        // and the one between them pairs up with the one between them in the old struct.
        ["Grown", [["_aaaaaaaaaaaaaaaaaaaag", INT], ["_aaaaaaaaaaaaaaaaaaaac", FLOAT], ["_aaaaaaaaaaaaaaaaaaaai", INT], ["_aaaaaaaaaaaaaaaaaaaad", NAME], ["_aaaaaaaaaaaaaaaaaaaah", FLOAT]]],
      ],
    });
    const restored = parseUsmapSchema(readUsmap(restoreUsmap(now, old).file));
    expect(restored.structs.find((s) => s.name === "Grown")!.properties.map((p) => p.name)).toEqual(["_aaaaaaaaaaaaaaaaaaaag", "Amount", "Middle", "Label", "_aaaaaaaaaaaaaaaaaaaah"]);
  });

  it("pairs the properties between two anchors by kind when the new struct has extra ones", () => {
    const was = usmap({ structs: [["Wheel", [["Mass", FLOAT], ["Gears", { array: { struct: "Gear" } }], ["Idle", FLOAT]]]] });
    // Two properties are new: a Bool and a Float, with the array (what `Gears` is) between them and the anchors.
    const now = usmap({ structs: [["Wheel", [["Mass", FLOAT], ["_aaaaaaaaaaaaaaaaaaaag", { array: UNKNOWN }], ["_aaaaaaaaaaaaaaaaaaaah", 1], ["_aaaaaaaaaaaaaaaaaaaai", FLOAT], ["Idle", FLOAT]]]] });
    const wheel = parseUsmapSchema(readUsmap(restoreUsmap(now, was).file)).structs[0]!.properties.map((p) => `${p.name}:${p.type}`);
    expect(wheel).toEqual(["Mass:Float", "Gears:Array<Struct:Gear>", "_aaaaaaaaaaaaaaaaaaaah:Bool", "_aaaaaaaaaaaaaaaaaaaai:Float", "Idle:Float"]);
  });

  it("names a property by its place when the struct only grew at the end, and by nothing else", () => {
    const was = usmap({ structs: [["Row", [["Data", { struct: "Inner" }], ["bFlag", 1]]], ["Moved", [["Id", INT], ["Name", NAME]]]] });
    const now = usmap({
      structs: [
        // `Row` kept its two members in place and gained one after them.
        ["Row", [["Data", { struct: "Inner" }], ["_aaaaaaaaaaaaaaaaaaaag", 1], ["_aaaaaaaaaaaaaaaaaaaah", 1]]],
        // `Moved` gained a member in front of the old ones: nothing can be told by place.
        ["Moved", [["Id", INT], ["_aaaaaaaaaaaaaaaaaaaai", FLOAT], ["_aaaaaaaaaaaaaaaaaaaaj", NAME]]],
      ],
    });
    const { file, report } = restoreUsmap(now, was);
    const names = parseUsmapSchema(readUsmap(file)).structs.map((st) => st.properties.map((p) => p.name));
    expect(names[0]).toEqual(["Data", "bFlag", "_aaaaaaaaaaaaaaaaaaaah"]);
    expect(report.guessed).toBe(1);
    // `Name` is paired with the last property by the kind of the properties between the anchors, not by a guess.
    expect(names[1]).toEqual(["Id", "_aaaaaaaaaaaaaaaaaaaai", "Name"]);
  });

  it("applies a hint to a name the structure cannot give, and to nothing else", () => {
    const was = usmap({ structs: [["Wheel", [["Mass", FLOAT]]]] });
    const now = usmap({ structs: [["Wheel", [["Mass", FLOAT]]], ["Fresh", [["_aaaaaaaaaaaaaaaaaaaag", INT], ["_aaaaaaaaaaaaaaaaaaaah", INT]]]] });
    const hints = { _aaaaaaaaaaaaaaaaaaaag: "RingCount", Mass: "Weight", _aaaaaaaaaaaaaaaaaaaax: "NotThere" };
    const { file, report } = restoreUsmap(now, was, hints);
    const names = parseUsmapSchema(readUsmap(file)).structs.map((st) => st.properties.map((p) => p.name));
    // The hint names the scrambled property; the name that is not scrambled is left alone; a hint for a name that is absent does nothing.
    expect(names).toEqual([["Mass"], ["RingCount", "_aaaaaaaaaaaaaaaaaaaah"]]);
    expect(report.hinted).toBe(1);
  });

  it("leaves a name alone when the old file gives it two answers", () => {
    const now = usmap({ structs: [["Reward", [["_aaaaaaaaaaaaaaaaaaaac", FLOAT], ["_aaaaaaaaaaaaaaaaaaaad", NAME], ["_aaaaaaaaaaaaaaaaaaaae", INT]]], ["Other", [["_aaaaaaaaaaaaaaaaaaaad", FLOAT]]]] });
    const { report } = restoreNames(schema(now), schema(old));
    expect(report.conflicting).toBe(1);
    expect(report.restored).toBe(2);
  });

  it("takes a type the file leaves unsaid from the property of the same name in the old file", () => {
    const was = usmap({ structs: [["Curve", [["Points", { array: { struct: "Point" } }], ["Mode", INT]]], ["Mix", [["Items", { array: INT }]]]] });
    const now = usmap({ structs: [["Curve", [["Points", { array: UNKNOWN }], ["Mode", INT]]], ["Mix", [["Items", { array: { struct: "Other" } }]]], ["Fresh", [["Things", { array: UNKNOWN }]]]] });
    const { file, report } = restoreUsmap(now, was);
    const types = parseUsmapSchema(readUsmap(file)).structs.map((s) => s.properties.map((p) => p.type));
    // `Mix` already says what it holds, whatever the old file says, and `Fresh` is not in the old file.
    expect(types).toEqual([["Array<Struct:Point>", "Int"], ["Array<Struct:Other>"], ["Array<Unknown>"]]);
    expect(report).toMatchObject({ typesRestored: 1, stillUnknown: 1 });
  });

  it("keeps the old file's capitals for a name the game spells another way in the new file", () => {
    const was = usmap({ structs: [["Row", [["EntityID", NAME], ["Cost", INT]]], ["Other", [["EntityId", NAME]]]] });
    const now = usmap({ structs: [["Row", [["EntityId", NAME], ["Cost", INT]]], ["Alone", [["EntityId", NAME]]]] });
    const { file, report } = restoreUsmap(now, was);
    expect(parseUsmapSchema(readUsmap(file)).structs.map((s) => s.properties.map((p) => p.name))).toEqual([["EntityID", "Cost"], ["EntityID"]]);
    expect(report.recased).toBe(1);
  });

  it("writes a file that reads back with the real names, uncompressed, from a compressed original", () => {
    const now = usmap({ structs: [["Reward", [["_aaaaaaaaaaaaaaaaaaaac", FLOAT], ["_aaaaaaaaaaaaaaaaaaaad", NAME], ["_aaaaaaaaaaaaaaaaaaaae", INT]]]] }, 3);
    const { file } = restoreUsmap(now, old);
    expect(parseUsmapHeader(file).compression).toBe(0);
    expect(namesOf(file, "Reward")).toEqual(["Amount", "Label", "Count"]);
    expect(scrambledShare(now)).toEqual({ scrambled: 3, properties: 3 });
    expect(scrambledShare(file)).toEqual({ scrambled: 0, properties: 3 });
  });
});
