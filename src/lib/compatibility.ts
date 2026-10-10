/** The part of a weapon slot that decides what fits (see `weapons.json`). */
export interface SlotRules {
  items: readonly string[];
  contexts: readonly string[];
  blockedItems: readonly string[];
  blockedContexts: readonly string[];
}

/** The part of an item that decides whether it fits. */
export interface FittingItem {
  id: string;
  tags: readonly string[];
}

/** True when `tag` is `context` or a sub-tag of it: `Item.Attachment.Sight.Short.X` matches `Item.Attachment.Sight.Short`. */
export const tagMatches = (tag: string, context: string): boolean => {
  const t = tag.toLowerCase();
  const c = context.toLowerCase();
  return t === c || t.startsWith(`${c}.`);
};

/**
 * Whether an item fits a slot, as the slot's rules read: it must be named by the slot or carry an allowed tag, and it
 * must be neither named in the block list nor carry a blocked tag (blocking wins). Ids and tags are compared without
 * regard to case, as the game does. This is derived from the slot rules in the data; the game's own check may have
 * further conditions that are not in the data.
 */
export function fitsSlot(item: FittingItem, slot: SlotRules): boolean {
  const id = item.id.toLowerCase();
  const named = slot.items.some((i) => i.toLowerCase() === id);
  const allowedTag = item.tags.some((t) => slot.contexts.some((c) => tagMatches(t, c)));
  if (!named && !allowedTag) return false;
  const blockedName = slot.blockedItems.some((i) => i.toLowerCase() === id);
  const blockedTag = item.tags.some((t) => slot.blockedContexts.some((c) => tagMatches(t, c)));
  return !blockedName && !blockedTag;
}

/** The items from `items` that fit a slot, in the given order. */
export const itemsFittingSlot = <T extends FittingItem>(slot: SlotRules, items: readonly T[]): T[] => items.filter((i) => fitsSlot(i, slot));
