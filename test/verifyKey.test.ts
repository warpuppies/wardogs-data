import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkKeyOnToc, summarizeKeyReports } from "../src/extract/verifyKey.js";

/** Builds a minimal IoStore TOC whose directory index is encrypted with `key`. */
function makeToc(key: Buffer, { encrypted = true, signed = true } = {}): Buffer {
  const headerSize = 144;
  const entries = 1;
  const blocks = 1;
  const methodCount = 1;
  const methodLength = 32;
  const sigSize = 4;

  const tables = entries * 12 + entries * 10 + blocks * 12 + methodCount * methodLength;
  const sigTable = signed ? 4 + sigSize * 2 + blocks * 20 : 0;
  const toc = Buffer.alloc(headerSize + tables + sigTable + 64);

  toc.write("-==--==--==--==-", 0, "latin1");
  toc.writeUInt32LE(headerSize, 20);
  toc.writeUInt32LE(entries, 24);
  toc.writeUInt32LE(blocks, 28);
  toc.writeUInt32LE(methodCount, 36);
  toc.writeUInt32LE(methodLength, 40);
  toc.writeUInt8((encrypted ? 0x02 : 0) | (signed ? 0x04 : 0), 80);

  let offset = headerSize + tables;
  if (signed) {
    toc.writeUInt32LE(sigSize, offset);
    offset += sigTable;
  }
  const plain = Buffer.alloc(32);
  plain.writeInt32LE(10, 0);
  plain.write("../../../\0", 4, "latin1");
  const cipher = createCipheriv("aes-256-ecb", key, null);
  cipher.setAutoPadding(false);
  Buffer.concat([cipher.update(plain), cipher.final()]).copy(toc, offset);
  return toc;
}

describe("checkKeyOnToc", () => {
  const key = randomBytes(32);
  const keyHex = key.toString("hex");

  it("accepts the correct key", () => {
    expect(checkKeyOnToc(makeToc(key), keyHex)).toEqual({ status: "ok", mount: "../../../\0" });
  });

  it("works for containers without a signature table", () => {
    expect(checkKeyOnToc(makeToc(key, { signed: false }), keyHex).status).toBe("ok");
  });

  it("rejects a wrong key", () => {
    expect(checkKeyOnToc(makeToc(key), randomBytes(32).toString("hex")).status).toBe("wrong-key");
  });

  it("reports unencrypted containers", () => {
    expect(checkKeyOnToc(makeToc(key, { encrypted: false }), keyHex).status).toBe("not-encrypted");
  });

  it("reports files that are not a TOC", () => {
    expect(checkKeyOnToc(Buffer.alloc(200), keyHex).status).toBe("unsupported");
  });
});

describe("summarizeKeyReports", () => {
  it("counts each outcome", () => {
    const counts = summarizeKeyReports([
      { file: "a", result: { status: "ok", mount: "" } },
      { file: "b", result: { status: "wrong-key" } },
      { file: "c", result: { status: "not-encrypted" } },
      { file: "d", result: { status: "unsupported", reason: "x" } },
    ]);
    expect(counts).toEqual({ ok: 1, wrong: 1, plain: 1, unsupported: 1 });
  });
});
