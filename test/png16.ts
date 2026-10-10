import { crc32, deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** Writes a 16-bit grayscale PNG with exact sample values. Test helper: real heightmaps come from the extractor. */
export function writePng16(file: string, width: number, height: number, values: ArrayLike<number>): void {
  if (values.length !== width * height) throw new Error("values must have width * height entries");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 16; // bit depth
  ihdr[9] = 0; // grayscale
  const rows = Buffer.alloc(height * (1 + width * 2)); // each row: filter byte 0, then big-endian samples
  for (let y = 0; y < height; y++) {
    const base = y * (1 + width * 2);
    for (let x = 0; x < width; x++) rows.writeUInt16BE(values[y * width + x] as number, base + 1 + x * 2);
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, png);
}
