import { brotliDecompressSync, zstdDecompressSync } from "node:zlib";

export const USMAP_MAGIC = 0x30c4;

/** The file versions that add something to the layout this reads. */
const VERSION_PACKAGE_VERSIONING = 1;
const VERSION_LONG_NAMES = 2;
const VERSION_LARGE_ENUMS = 3;
const VERSION_EXPLICIT_ENUM_VALUES = 4;

export interface UsmapInfo {
  version: number;
  /** 0 = none, 1 = Oodle, 2 = Brotli, 3 = ZStandard. */
  compression: number;
}

export interface UsmapFile extends UsmapInfo {
  /** The bytes of the header before the compression method, which stay as they are when the file is written again. */
  headStart: Buffer;
  /** The decompressed body: the name table, the enums and the structs. */
  payload: Buffer;
}

/** Reads the header of a .usmap file: where the compression method and the sizes are, and what they say. */
function readHeader(buf: Buffer): UsmapInfo & { at: number; compressedSize: number; size: number } {
  if (buf.length < 4 || buf.readUInt16LE(0) !== USMAP_MAGIC) {
    throw new Error("Not a .usmap file (bad magic number).");
  }
  const version = buf.readUInt8(2);
  let at = 3;
  if (version >= VERSION_PACKAGE_VERSIONING) {
    const versioned = buf.readInt32LE(at) !== 0;
    at += 4;
    if (versioned) {
      // Engine versions, the custom versions (a guid and a number each) and the network changelist.
      at += 8;
      at += 4 + buf.readInt32LE(at) * 20;
      at += 4;
    }
  }
  if (buf.length < at + 9) return { version, compression: buf.length > at ? buf.readUInt8(at) : 0, at, compressedSize: 0, size: 0 };
  return { version, compression: buf.readUInt8(at), at, compressedSize: buf.readUInt32LE(at + 1), size: buf.readUInt32LE(at + 5) };
}

/** Validates a .usmap header. Throws if the file is not a mappings file. */
export function parseUsmapHeader(bytes: Uint8Array): UsmapInfo {
  const { version, compression } = readHeader(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return { version, compression };
}

/** Reads a whole .usmap file, decompressing its body. Oodle is not supported. */
export function readUsmap(bytes: Uint8Array): UsmapFile {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { version, compression, at, compressedSize, size } = readHeader(buf);
  const body = buf.subarray(at + 9, at + 9 + compressedSize);
  if (body.length !== compressedSize) throw new Error("The .usmap file is cut short.");
  let payload: Buffer;
  if (compression === 0) payload = Buffer.from(body);
  else if (compression === 2) payload = brotliDecompressSync(body);
  else if (compression === 3) payload = zstdDecompressSync(body);
  else throw new Error(`The .usmap file uses compression method ${compression}, which this cannot read (Oodle).`);
  if (payload.length !== size) throw new Error("The .usmap file does not decompress to the size its header gives.");
  return { version, compression, headStart: Buffer.from(buf.subarray(0, at)), payload };
}

/** Writes a .usmap file with an uncompressed body. */
export function writeUsmap(file: Pick<UsmapFile, "headStart" | "payload">): Buffer {
  const tail = Buffer.alloc(9);
  tail.writeUInt8(0, 0);
  tail.writeUInt32LE(file.payload.length, 1);
  tail.writeUInt32LE(file.payload.length, 5);
  return Buffer.concat([file.headStart, tail, file.payload]);
}

/** A property's type as the file has it: a type id, and for some ids a name (of a struct or an enum) or the types inside. */
export interface UsmapType {
  id: number;
  /** An index into the name table: the struct of a struct type, the enum of an enum type. */
  name?: number;
  /** What an enum is stored as, or what an array, set or optional holds, or the key of a map. */
  inner?: UsmapType;
  /** The value of a map. */
  value?: UsmapType;
}

export interface UsmapProperty {
  index: number;
  name: string;
  /** The type as text, such as `Array<Struct:FVector>`, so two properties can be compared. */
  type: string;
  nameIndex: number;
  /** The number of array elements. */
  dim: number;
  tree: UsmapType;
}

export interface UsmapStruct {
  name: string;
  nameIndex: number;
  superIndex: number;
  /** The number of properties counting every array element, as the file states it. */
  propertyCount: number;
  properties: UsmapProperty[];
}

export interface UsmapEnum {
  name: string;
  values: string[];
}

export interface UsmapSchema {
  names: string[];
  /** The enums as the file has them (they refer to the name table by index, so a change of the names leaves them alone). */
  enumBytes: Buffer;
  enums: UsmapEnum[];
  structs: UsmapStruct[];
}

const UNKNOWN = 255;

/** True when the type, or a type inside it, is one the file does not say. */
export function hasUnknown(type: UsmapType): boolean {
  return type.id === UNKNOWN || (!!type.inner && hasUnknown(type.inner)) || (!!type.value && hasUnknown(type.value));
}

const TYPE_NAMES: Record<number, string> = {
  0: "Byte", 1: "Bool", 2: "Int", 3: "Float", 4: "Object", 5: "Name", 6: "Delegate", 7: "Double", 8: "Array", 9: "Struct",
  10: "Str", 11: "Text", 12: "Interface", 13: "MulticastDelegate", 14: "WeakObject", 15: "LazyObject", 16: "AssetObject",
  17: "SoftObject", 18: "UInt64", 19: "UInt32", 20: "UInt16", 21: "Int64", 22: "Int16", 23: "Int8", 24: "Map", 25: "Set",
  26: "Enum", 27: "FieldPath", 28: "Optional", 29: "Utf8Str", 30: "AnsiStr", 255: "Unknown",
};

/** Reads the name table, enums and structs of a .usmap body. */
export function parseUsmapSchema(file: Pick<UsmapFile, "version" | "payload">): UsmapSchema {
  const { version, payload } = file;
  let at = 0;
  const u8 = (): number => payload.readUInt8(at++);
  const u16 = (): number => ((at += 2), payload.readUInt16LE(at - 2));
  const u32 = (): number => ((at += 4), payload.readUInt32LE(at - 4));
  const i32 = (): number => ((at += 4), payload.readInt32LE(at - 4));

  const names: string[] = [];
  const nameCount = u32();
  for (let i = 0; i < nameCount; i++) {
    const length = version >= VERSION_LONG_NAMES ? u16() : u8();
    names.push(payload.toString("latin1", at, at + length));
    at += length;
  }
  const enumStart = at;
  const nameIndex = (): number => {
    const index = i32();
    if (names[index] === undefined) throw new Error(`The .usmap file names a name (${index}) that is not in its name table.`);
    return index;
  };
  const nameAt = (): string => names[nameIndex()]!;

  const enums: UsmapEnum[] = [];
  const enumCount = u32();
  for (let i = 0; i < enumCount; i++) {
    const name = nameAt();
    const count = version >= VERSION_LARGE_ENUMS ? u16() : u8();
    const values: string[] = [];
    for (let v = 0; v < count; v++) {
      if (version >= VERSION_EXPLICIT_ENUM_VALUES) at += 8;
      values.push(nameAt());
    }
    enums.push({ name, values });
  }

  const readType = (): UsmapType => {
    const id = u8();
    if (TYPE_NAMES[id] === undefined) throw new Error(`The .usmap file has a property type (${id}) this does not know.`);
    switch (id) {
      case 26: {
        const inner = readType();
        return { id, inner, name: nameIndex() };
      }
      case 9:
        return { id, name: nameIndex() };
      case 8:
      case 25:
      case 28:
        return { id, inner: readType() };
      case 24: {
        const inner = readType();
        return { id, inner, value: readType() };
      }
      default:
        return { id };
    }
  };

  const enumBytes = payload.subarray(enumStart, at);
  const structs: UsmapStruct[] = [];
  const structCount = u32();
  for (let i = 0; i < structCount; i++) {
    const structName = nameIndex();
    const superIndex = i32();
    const propertyCount = u16();
    const serializable = u16();
    const properties: UsmapProperty[] = [];
    for (let p = 0; p < serializable; p++) {
      const index = u16();
      const dim = u8();
      const propertyName = nameIndex();
      const tree = readType();
      properties.push({ index, dim, nameIndex: propertyName, name: names[propertyName]!, tree, type: describeType(tree, names) });
    }
    structs.push({ name: names[structName]!, nameIndex: structName, superIndex, propertyCount, properties });
  }
  if (at !== payload.length) throw new Error("The .usmap file has bytes left over after its last struct.");
  return { names, enumBytes, enums, structs };
}

/** A type as text, such as `Array<Struct:FVector>`. */
export function describeType(type: UsmapType, names: string[]): string {
  const label = TYPE_NAMES[type.id]!;
  switch (type.id) {
    case 26:
      return `Enum:${names[type.name!]}<${describeType(type.inner!, names)}>`;
    case 9:
      return `Struct:${names[type.name!]}`;
    case 8:
    case 25:
    case 28:
      return `${label}<${describeType(type.inner!, names)}>`;
    case 24:
      return `Map<${describeType(type.inner!, names)},${describeType(type.value!, names)}>`;
    default:
      return label;
  }
}

function writeType(type: UsmapType, out: number[]): void {
  out.push(type.id);
  const index = (n: number): void => void out.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255);
  switch (type.id) {
    case 26:
      writeType(type.inner!, out);
      index(type.name!);
      break;
    case 9:
      index(type.name!);
      break;
    case 8:
    case 25:
    case 28:
      writeType(type.inner!, out);
      break;
    case 24:
      writeType(type.inner!, out);
      writeType(type.value!, out);
      break;
  }
}

/** The body of a file: the name table, the enums as they were, and the structs. */
export function serializeSchema(schema: Pick<UsmapSchema, "enumBytes" | "structs">, names: string[], version: number): Buffer {
  const parts: Buffer[] = [];
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  parts.push(u32(names.length));
  for (const name of names) {
    const bytes = Buffer.from(name, "latin1");
    const length = Buffer.alloc(version >= VERSION_LONG_NAMES ? 2 : 1);
    if (length.length === 2) length.writeUInt16LE(bytes.length);
    else length.writeUInt8(bytes.length);
    parts.push(length, bytes);
  }
  parts.push(schema.enumBytes, u32(schema.structs.length));
  for (const s of schema.structs) {
    const bytes: number[] = [];
    const word = (n: number): void => void bytes.push(n & 255, (n >> 8) & 255);
    const index = (n: number): void => void bytes.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255);
    index(s.nameIndex);
    index(s.superIndex);
    word(s.propertyCount);
    word(s.properties.length);
    for (const p of s.properties) {
      word(p.index);
      bytes.push(p.dim);
      index(p.nameIndex);
      writeType(p.tree, bytes);
    }
    parts.push(Buffer.from(bytes));
  }
  return Buffer.concat(parts);
}
