import type { Item } from "../schema.js";

export interface SlotValue {
  id: string;
  name: string;
  variation: string;
  cells: number;
  /** Price of one unit (price / amount sold per purchase). */
  unitPrice: number;
  /** Value of a full stack: unit price x max stack. */
  stackValue: number;
  /** Stack value divided by the cells the item occupies. */
  perSlot: number;
}

/** Ranks every priced item variation by value per inventory cell, accounting for stack size. */
export function valuePerSlot(items: Item[]): SlotValue[] {
  const rows: SlotValue[] = [];
  for (const item of items) {
    const cells = item.grid[0] * item.grid[1];
    for (const v of item.vendor) {
      const unitPrice = v.price / v.amount;
      const stackValue = unitPrice * item.maxStack;
      rows.push({ id: item.id, name: item.name, variation: v.tag, cells, unitPrice, stackValue, perSlot: stackValue / cells });
    }
  }
  return rows.sort((a, b) => b.perSlot - a.perSlot || a.id.localeCompare(b.id));
}
