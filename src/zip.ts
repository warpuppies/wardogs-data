import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

export interface ZipEntry {
  /** Path inside the archive, with forward slashes. */
  name: string;
  /** File on disk. */
  file: string;
}

/** Formats that are already compressed; storing them is smaller and faster than deflating them again. */
const STORED = /\.(webp|png|zip|gz)$/i;

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
/** 1980-01-01 00:00:00, the earliest DOS time, so the same files always give the same bytes. */
const DOS_TIME = 0;
const DOS_DATE = 0x21;
/** Unix regular file, mode 644, in the high half of the external attributes. */
const EXTERNAL_ATTRIBUTES = (0o100644 << 16) >>> 0;
const UTF8_NAMES = 0x0800;

/**
 * Writes a reproducible ZIP archive: entries sorted by name, one fixed timestamp, no extra fields, so the same files
 * give the same bytes on every run. Images stay stored and everything else is deflated. Zip64 is not supported; an
 * archive over 4 GB or 65,535 entries is an error.
 */
export function writeZip(entries: readonly ZipEntry[], outFile: string): void {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (sorted.length > 0xfffe) throw new Error(`Too many files for a zip without zip64: ${sorted.length}`);
  for (let i = 1; i < sorted.length; i++) if (sorted[i]!.name === sorted[i - 1]!.name) throw new Error(`Duplicate name in the archive: ${sorted[i]!.name}`);

  mkdirSync(dirname(outFile), { recursive: true });
  const fd = openSync(outFile, "w");
  const central: Buffer[] = [];
  let offset = 0;
  const write = (buffer: Buffer): void => {
    let written = 0;
    while (written < buffer.length) written += writeSync(fd, buffer, written);
    offset += buffer.length;
  };
  try {
    for (const entry of sorted) {
      const data = readFileSync(entry.file);
      const name = Buffer.from(entry.name, "utf8");
      const crc = crc32(data);
      let method = 0;
      let body = data;
      if (!STORED.test(entry.name) && data.length > 0) {
        const deflated = deflateRawSync(data, { level: 9 });
        if (deflated.length < data.length) {
          method = 8;
          body = deflated;
        }
      }
      if (offset + body.length + name.length > 0xffffffff || data.length > 0xffffffff) throw new Error("The archive is larger than a zip without zip64 can hold.");

      const local = Buffer.alloc(30);
      local.writeUInt32LE(LOCAL, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(UTF8_NAMES, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(DOS_TIME, 10);
      local.writeUInt16LE(DOS_DATE, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);

      const record = Buffer.alloc(46);
      record.writeUInt32LE(CENTRAL, 0);
      record.writeUInt16LE(0x031e, 4); // made by Unix, version 3.0
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(UTF8_NAMES, 8);
      record.writeUInt16LE(method, 10);
      record.writeUInt16LE(DOS_TIME, 12);
      record.writeUInt16LE(DOS_DATE, 14);
      record.writeUInt32LE(crc, 16);
      record.writeUInt32LE(body.length, 20);
      record.writeUInt32LE(data.length, 24);
      record.writeUInt16LE(name.length, 28);
      record.writeUInt32LE(EXTERNAL_ATTRIBUTES, 38);
      record.writeUInt32LE(offset, 42);
      central.push(record, name);

      write(local);
      write(name);
      write(body);
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END, 0);
    end.writeUInt16LE(sorted.length, 8);
    end.writeUInt16LE(sorted.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    write(directory);
    write(end);
  } finally {
    closeSync(fd);
  }
}
