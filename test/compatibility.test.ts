import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fitsSlot, itemsFittingSlot, tagMatches, type SlotRules } from "../src/lib/index.js";
import { ItemsFile } from "../src/schema.js";
import { WeaponsFile } from "../src/schema.gameplay.js";

const slot = (over: Partial<SlotRules> = {}): SlotRules => ({ items: [], contexts: [], blockedItems: [], blockedContexts: [], ...over });
const item = (id: string, ...tags: string[]) => ({ id, tags });

describe("tagMatches", () => {
  it("matches the tag itself and its sub-tags, not longer names or parents", () => {
    expect(tagMatches("Item.Attachment.Sight.Short", "Item.Attachment.Sight.Short")).toBe(true);
    expect(tagMatches("Item.Attachment.Sight.Short.Red", "Item.Attachment.Sight.Short")).toBe(true);
    expect(tagMatches("Item.Attachment.Sight.Shorter", "Item.Attachment.Sight.Short")).toBe(false);
    expect(tagMatches("Item.Attachment.Sight", "Item.Attachment.Sight.Short")).toBe(false);
  });

  it("ignores case", () => {
    expect(tagMatches("item.attachment.SIGHT", "Item.Attachment.Sight")).toBe(true);
  });
});

describe("fitsSlot", () => {
  it("fits when the item is named or carries an allowed tag", () => {
    const s = slot({ items: ["Id.Item.Scope"], contexts: ["Item.Attachment.Sight.Short"] });
    expect(fitsSlot(item("Id.Item.Scope"), s)).toBe(true);
    expect(fitsSlot(item("Id.Item.Dot", "Item.Attachment.Sight.Short"), s)).toBe(true);
    expect(fitsSlot(item("Id.Item.Other", "Item.Attachment.Sight.Long"), s)).toBe(false);
    expect(fitsSlot(item("Id.Item.Plain"), s)).toBe(false);
  });

  it("lets a block win over an allow, by name or by tag", () => {
    const s = slot({ contexts: ["Item.Caliber.545mm"], blockedContexts: ["Item.Caliber.556mm"], blockedItems: ["Id.Item.Bad"] });
    expect(fitsSlot(item("Id.Item.Good", "Item.Caliber.545mm"), s)).toBe(true);
    expect(fitsSlot(item("Id.Item.Both", "Item.Caliber.545mm", "Item.Caliber.556mm"), s)).toBe(false);
    expect(fitsSlot(item("Id.Item.Bad", "Item.Caliber.545mm"), s)).toBe(false);
  });

  it("compares ids without regard to case, as the game does", () => {
    expect(fitsSlot(item("ID.Item.SKSBarrel"), slot({ items: ["Id.Item.SKSBarrel"] }))).toBe(true);
    expect(fitsSlot(item("Id.Item.X"), slot({ items: ["Id.Item.X"], blockedItems: ["ID.ITEM.X"] }))).toBe(false);
  });

  it("fits nothing when the slot allows nothing", () => {
    expect(fitsSlot(item("Id.Item.A", "Item.Any"), slot())).toBe(false);
  });
});

describe("itemsFittingSlot", () => {
  it("keeps the order of the items", () => {
    const items = [item("c", "T"), item("a", "T"), item("b")];
    expect(itemsFittingSlot(slot({ contexts: ["T"] }), items).map((i) => i.id)).toEqual(["c", "a"]);
  });
});

describe("committed data: the AK74M", () => {
  const items = ItemsFile.parse(JSON.parse(readFileSync("data/items.json", "utf8"))).items;
  const ak = WeaponsFile.parse(JSON.parse(readFileSync("data/weapons.json", "utf8"))).weapons.find((w) => w.id === "Id.Item.AK74M")!;
  const fits = (slotName: string) => itemsFittingSlot(ak.slots.find((s) => s.slot === slotName)!, items).map((i) => i.id);

  it("takes its three magazines and the 5.45 ammo, and not 5.56", () => {
    expect(fits("Magazine").sort()).toEqual(["Id.Item.AK74MExtendedMagazine", "Id.Item.AK74MMagazine", "Id.Item.AK74MMagazine75rnd"].sort());
    const ammo = fits("Chamber");
    expect(ammo).toContain("Id.Item.545mm");
    expect(ammo.some((id) => /556mm/.test(id))).toBe(false);
  });

  it("takes the 3x scope by name and a red dot by tag", () => {
    const sights = fits("Sight");
    expect(sights).toContain("Id.Item.3xScope");
    expect(sights.length).toBeGreaterThanOrEqual(10);
  });

  it("starts with the standard magazine in its default slot", () => {
    expect(ak.slots.find((s) => s.slot === "Magazine")?.default).toBe("Id.Item.AK74MMagazine");
    expect(fits("Magazine")).toContain("Id.Item.AK74MMagazine");
  });
});
