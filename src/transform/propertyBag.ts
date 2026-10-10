type Props = Record<string, any>; // decoded game properties: shapes are checked field by field below

/** The scalar types the decoder reads, with their size in bytes. Anything else throws, so a new type fails the build. */
const SCALARS: Record<string, { size: number; read: (b: Buffer, at: number) => number }> = {
  Int32: { size: 4, read: (b, at) => b.readInt32LE(at) },
  UInt32: { size: 4, read: (b, at) => b.readUInt32LE(at) },
  Float: { size: 4, read: (b, at) => b.readFloatLE(at) },
  Double: { size: 8, read: (b, at) => b.readDoubleLE(at) },
};

/**
 * Decodes the values of a property bag (`FInstancedPropertyBag`) that holds only numbers. The export gives the
 * property descriptions and the bag's bytes (base64, `Data`). The bytes use the engine's unversioned property format:
 * a header of fragments (16 bits each: properties to skip, whether any value is zero, whether it is the last fragment,
 * how many properties follow), then a mask with one bit per value of a fragment that has zeros (set means the value is
 * zero and absent from the data), then the non-zero values in property order. Properties are in the order of the
 * descriptions. Throws on any other type or on bytes left over.
 */
export function decodeNumberBag(bag: Props): Record<string, number> {
  const descs = (bag.PropertyDescs ?? []) as Props[];
  const data = Buffer.from(String(bag.Data ?? ""), "base64");
  if (descs.length === 0) return {};
  if (data.length !== bag.SerialSize) throw new Error(`Property bag has ${data.length} bytes, but declares ${bag.SerialSize}`);

  let at = 0;
  const fragments: Array<{ skip: number; zeroes: boolean; count: number }> = [];
  for (let last = false; !last; ) {
    if (at + 2 > data.length) throw new Error("Property bag header ends early");
    const word = data.readUInt16LE(at);
    at += 2;
    fragments.push({ skip: word & 0x7f, zeroes: (word & 0x80) !== 0, count: word >> 9 });
    last = (word & 0x100) !== 0;
  }
  const maskBits = fragments.filter((f) => f.zeroes).reduce((n, f) => n + f.count, 0);
  const maskBytes = maskBits === 0 ? 0 : maskBits <= 8 ? 1 : maskBits <= 16 ? 2 : Math.ceil(maskBits / 32) * 4;
  const mask = data.subarray(at, at + maskBytes);
  at += maskBytes;

  const out: Record<string, number> = {};
  let index = 0;
  let maskBit = 0;
  for (const fragment of fragments) {
    index += fragment.skip;
    for (let i = 0; i < fragment.count; i++, index++) {
      const desc = descs[index];
      if (!desc) throw new Error(`Property bag fragment points past its ${descs.length} properties`);
      const type = String(desc.ValueType ?? "").replace(/^E[A-Za-z]+::/, "");
      const scalar = SCALARS[type];
      if (!scalar || (desc.ContainerTypes?.Types ?? []).length > 0) throw new Error(`Property bag property ${desc.Name} has the unsupported type ${type}`);
      const zero = fragment.zeroes && ((mask[maskBit >> 3] ?? 0) & (1 << (maskBit & 7))) !== 0;
      if (fragment.zeroes) maskBit++;
      if (zero) {
        out[String(desc.Name)] = 0;
        continue;
      }
      if (at + scalar.size > data.length) throw new Error(`Property bag value ${desc.Name} runs past the data`);
      out[String(desc.Name)] = scalar.read(data, at);
      at += scalar.size;
    }
  }
  if (at !== data.length) throw new Error(`Property bag has ${data.length - at} bytes left after its values`);
  return out;
}
