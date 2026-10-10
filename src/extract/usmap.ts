export const USMAP_MAGIC = 0x30c4;

export interface UsmapInfo {
  version: number;
  /** 0 = none, 1 = Oodle, 2 = Brotli, 3 = ZStandard. */
  compression: number;
}

/** Validates a .usmap header. Throws if the file is not a mappings file. */
export function parseUsmapHeader(bytes: Uint8Array): UsmapInfo {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 16));
  if (buf.length < 4 || buf.readUInt16LE(0) !== USMAP_MAGIC) {
    throw new Error("Not a .usmap file (bad magic number).");
  }
  return { version: buf.readUInt8(2), compression: buf.readUInt8(3) };
}
