import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { writeZip } from "../src/zip.js";

function put(path: string, content: string | Buffer): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** A minimal reader: walks the central directory and returns each entry's name, method and uncompressed bytes. */
function readZip(file: string): Array<{ name: string; method: number; data: Buffer }> {
  const zip = readFileSync(file);
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out: Array<{ name: string; method: number; data: Buffer }> = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const body = zip.subarray(dataStart, dataStart + size);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    expect(crc32(data), name).toBe(crc);
    out.push({ name, method, data });
    at += 46 + nameLength;
  }
  return out;
}

describe("writeZip", () => {
  const dir = mkdtempSync(join(tmpdir(), "wardogs-zip-"));
  const json = put(join(dir, "in/a.json"), JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ id: `Id.Item.${i}` })) }));
  const image = put(join(dir, "in/b.webp"), Buffer.from([1, 2, 3, 4, 5]));
  const empty = put(join(dir, "in/empty.txt"), "");
  const entries = [
    { name: "pkg/z-last.json", file: json },
    { name: "pkg/tiles/b.webp", file: image },
    { name: "pkg/empty.txt", file: empty },
  ];

  it("round-trips every entry, sorted by name, deflating text and storing images", () => {
    const out = join(dir, "out/a.zip");
    writeZip(entries, out);
    const read = readZip(out);
    expect(read.map((e) => e.name)).toEqual(["pkg/empty.txt", "pkg/tiles/b.webp", "pkg/z-last.json"]);
    expect(read.find((e) => e.name === "pkg/z-last.json")!.method).toBe(8);
    expect(read.find((e) => e.name === "pkg/tiles/b.webp")!.method).toBe(0);
    expect(read.find((e) => e.name === "pkg/z-last.json")!.data.equals(readFileSync(json))).toBe(true);
    expect(read.find((e) => e.name === "pkg/empty.txt")!.data.length).toBe(0);
  });

  it("gives the same bytes on every run, whatever the order of the entries", () => {
    const a = join(dir, "out/one.zip");
    const b = join(dir, "out/two.zip");
    writeZip(entries, a);
    writeZip([...entries].reverse(), b);
    expect(readFileSync(a).equals(readFileSync(b))).toBe(true);
  });

  it("refuses duplicate names", () => {
    expect(() => writeZip([entries[0]!, { name: entries[0]!.name, file: image }], join(dir, "out/dup.zip"))).toThrow(/Duplicate/);
  });

  it("makes archives that the unzip tool accepts", () => {
    const out = join(dir, "out/check.zip");
    writeZip(entries, out);
    const probe = spawnSync("unzip", ["-tq", out], { encoding: "utf8" });
    if (probe.error) return; // unzip is not installed here
    expect(probe.status, probe.stdout + probe.stderr).toBe(0);
  });
});
