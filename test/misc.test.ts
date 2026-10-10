import { describe, expect, it } from "vitest";
import { normalizeAesKey } from "../src/config.js";
import { parseUsmapHeader } from "../src/extract/usmap.js";
import { readManifestField } from "../src/extract/steam.js";
import { dotnetCommand } from "../src/extract/run.js";

describe("normalizeAesKey", () => {
  const hex = "ab".repeat(32);
  it("accepts 0x-prefixed and plain keys, in any case", () => {
    expect(normalizeAesKey(`0x${hex.toUpperCase()}\n`)).toBe(hex);
    expect(normalizeAesKey(hex)).toBe(hex);
  });
  it("rejects keys of the wrong length or alphabet", () => {
    expect(() => normalizeAesKey("abcd")).toThrow(/64 hex/);
    expect(() => normalizeAesKey("zz".repeat(32))).toThrow(/64 hex/);
  });
});

describe("parseUsmapHeader", () => {
  it("reads version and compression", () => {
    expect(parseUsmapHeader(Uint8Array.from([0xc4, 0x30, 4, 0, 0, 0]))).toEqual({ version: 4, compression: 0 });
  });
  it("rejects other files", () => {
    expect(() => parseUsmapHeader(Uint8Array.from([0x50, 0x4b, 3, 4]))).toThrow(/usmap/);
    expect(() => parseUsmapHeader(new Uint8Array())).toThrow();
  });
});

describe("readManifestField", () => {
  const vdf = `"AppState"\n{\n\t"appid"\t\t"123"\n\t"buildid"\t\t"456789"\n}`;
  it("extracts a field", () => {
    expect(readManifestField(vdf, "buildid")).toBe("456789");
  });
  it("returns undefined when absent", () => {
    expect(readManifestField(vdf, "missing")).toBeUndefined();
  });
});

describe("dotnetCommand", () => {
  it("uses DOTNET_ROOT when set, because an env file cannot extend PATH", () => {
    expect(dotnetCommand({ DOTNET_ROOT: "/opt/dotnet" })).toBe("/opt/dotnet/dotnet");
  });
  it("falls back to dotnet on PATH", () => {
    expect(dotnetCommand({})).toBe("dotnet");
  });
});
