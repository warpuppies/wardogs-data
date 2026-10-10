import { describe, expect, it } from "vitest";
import type { Item } from "../src/schema.js";
import { valuePerSlot } from "../src/analyze/valuePerSlot.js";

const item = (over: Partial<Item> & Pick<Item, "id">): Item => ({
  kind: "item",
  asset: "x",
  name: over.id,
  tags: [],
  grid: [1, 1],
  maxStack: 1,
  unlock: null,
  vendor: [],
  ...over,
});
const price = (p: number, amount = 1) => ({ tag: "t", price: p, amount, categories: [] });

describe("valuePerSlot", () => {
  it("ranks a 1x1 item worth 600 that stacks to 2 above a single 800 item", () => {
    const rows = valuePerSlot([
      item({ id: "stacks", maxStack: 2, vendor: [price(600)] }),
      item({ id: "single", vendor: [price(800)] }),
    ]);
    expect(rows.map((r) => [r.id, r.perSlot])).toEqual([
      ["stacks", 1200],
      ["single", 800],
    ]);
  });

  it("divides by the cells an item occupies", () => {
    const [row] = valuePerSlot([item({ id: "big", grid: [2, 2], vendor: [price(1000)] })]);
    expect(row?.perSlot).toBe(250);
  });

  it("prices ammo per unit when sold in lots", () => {
    const [row] = valuePerSlot([item({ id: "ammo", grid: [2, 2], maxStack: 100, vendor: [price(600, 10)] })]);
    expect(row).toMatchObject({ unitPrice: 60, stackValue: 6000, perSlot: 1500 });
  });

  it("skips items without a vendor price", () => {
    expect(valuePerSlot([item({ id: "free" })])).toEqual([]);
  });
});
