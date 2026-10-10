import { createDecipheriv } from "node:crypto";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";

const TOC_MAGIC = "-==--==--==--==-";
const FLAG_ENCRYPTED = 0x02;
const FLAG_SIGNED = 0x04;

export type KeyCheck =
  | { status: "ok"; mount: string }
  | { status: "wrong-key" }
  | { status: "not-encrypted" }
  | { status: "unsupported"; reason: string };

/**
 * Checks an AES key against one IoStore `.utoc` container header. An encrypted container's directory
 * index starts with a length-prefixed mount path ("../../../..."), so a correct key decrypts the first
 * block to a small length plus that prefix, while a wrong key yields random bytes.
 *
 * Layout assumptions follow the IoStore TOC format used by UE 5.x. If the engine changes the layout this
 * returns "unsupported" or "wrong-key", and the canary tests/`doctor` will flag it.
 */
export function checkKeyOnToc(toc: Buffer, keyHex: string): KeyCheck {
  if (toc.length < 100 || toc.subarray(0, 16).toString("latin1") !== TOC_MAGIC) {
    return { status: "unsupported", reason: "not an IoStore TOC" };
  }
  const flags = toc.readUInt8(80);
  if (!(flags & FLAG_ENCRYPTED)) return { status: "not-encrypted" };

  const headerSize = toc.readUInt32LE(20);
  const entries = toc.readUInt32LE(24);
  const blocks = toc.readUInt32LE(28);
  const methodCount = toc.readUInt32LE(36);
  const methodLength = toc.readUInt32LE(40);
  const hashSeeds = toc.readUInt32LE(84);
  const withoutHash = toc.readUInt32LE(96);

  let offset =
    headerSize + entries * 12 + entries * 10 + hashSeeds * 4 + withoutHash * 4 + blocks * 12 + methodCount * methodLength;
  if (flags & FLAG_SIGNED) {
    if (offset + 4 > toc.length) return { status: "unsupported", reason: "signature table out of range" };
    const sigSize = toc.readUInt32LE(offset);
    offset += 4 + sigSize * 2 + blocks * 20;
  }
  if (offset + 32 > toc.length) return { status: "unsupported", reason: "directory index out of range" };

  const decipher = createDecipheriv("aes-256-ecb", Buffer.from(keyHex, "hex"), null);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(toc.subarray(offset, offset + 32)), decipher.final()]);
  const length = plain.readInt32LE(0);
  const prefix = plain.subarray(4, 13).toString("latin1");
  if (length > 0 && length < 64 && prefix === "../../../") {
    return { status: "ok", mount: plain.subarray(4, 4 + Math.min(length, 12)).toString("latin1") };
  }
  return { status: "wrong-key" };
}

export interface KeyReport {
  file: string;
  result: KeyCheck;
}

/** Checks the key against every `.utoc` in the Paks folder. */
export async function verifyKeyAgainstInstall(paksDir: string, keyHex: string): Promise<KeyReport[]> {
  const files = (await readdir(paksDir)).filter((f) => f.endsWith(".utoc")).sort();
  const reports: KeyReport[] = [];
  for (const file of files) {
    const handle = await open(join(paksDir, file), "r");
    try {
      const { size } = await handle.stat();
      const buffer = Buffer.alloc(Math.min(size, 16 * 1024 * 1024));
      await handle.read(buffer, 0, buffer.length, 0);
      reports.push({ file, result: checkKeyOnToc(buffer, keyHex) });
    } finally {
      await handle.close();
    }
  }
  return reports;
}

export function summarizeKeyReports(reports: KeyReport[]): { ok: number; wrong: number; plain: number; unsupported: number } {
  const count = { ok: 0, wrong: 0, plain: 0, unsupported: 0 };
  for (const { result } of reports) {
    if (result.status === "ok") count.ok++;
    else if (result.status === "wrong-key") count.wrong++;
    else if (result.status === "not-encrypted") count.plain++;
    else count.unsupported++;
  }
  return count;
}
