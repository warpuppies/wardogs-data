import { describe, expect, it } from "vitest";
import { decodeNumberBag } from "../src/transform/propertyBag.js";

const desc = (Name: string, type: string) => ({ Name, ValueType: `EPropertyBagPropertyType::${type}`, ContainerTypes: { Types: [] } });
const bag = (descs: object[], hex: string) => ({ PropertyDescs: descs, SerialSize: hex.length / 2, Data: Buffer.from(hex, "hex").toString("base64") });

describe("decodeNumberBag", () => {
  it("reads a single int and a single float (the game's own bytes)", () => {
    expect(decodeNumberBag(bag([desc("CashThreshold", "Int32")], "0003a0860100"))).toEqual({ CashThreshold: 100000 });
    expect(decodeNumberBag(bag([desc("RequiredSeconds", "Float")], "000300006145"))).toEqual({ RequiredSeconds: 3600 });
    expect(decodeNumberBag(bag([desc("DistanceThreshold", "Float")], "0003008cb947"))).toEqual({ DistanceThreshold: 95000 });
  });

  it("reads two properties in one fragment", () => {
    // fragment: 2 values, last => 0x0500; values 7 and 1.5
    expect(decodeNumberBag(bag([desc("A", "Int32"), desc("B", "Float")], "0005" + "07000000" + "0000c03f"))).toEqual({ A: 7, B: 1.5 });
  });

  it("skips properties a fragment leaves out, and reads a zero from the mask", () => {
    // fragment: skip 1, has zeroes, last, 2 values => 0x0500 | 0x80 | 1 = 0x0581; mask 0b01 (first value zero); then one value
    expect(decodeNumberBag(bag([desc("Skipped", "Int32"), desc("Zero", "Int32"), desc("Set", "Int32")], "8105" + "01" + "09000000"))).toEqual({ Zero: 0, Set: 9 });
  });

  it("returns nothing for a bag without properties", () => {
    expect(decodeNumberBag({ PropertyDescs: [], SerialSize: 0 })).toEqual({});
  });

  it("fails loudly on a type it does not know, a truncated value, or leftover bytes", () => {
    expect(() => decodeNumberBag(bag([desc("Name", "Name")], "0003" + "00000000"))).toThrow(/unsupported type Name/);
    expect(() => decodeNumberBag(bag([desc("A", "Int32")], "000300"))).toThrow(/runs past/);
    expect(() => decodeNumberBag(bag([desc("A", "Int32")], "0003" + "01000000" + "00"))).toThrow(/left after/);
    expect(() => decodeNumberBag({ PropertyDescs: [desc("A", "Int32")], SerialSize: 9, Data: "AAA=" })).toThrow(/declares 9/);
  });
});
