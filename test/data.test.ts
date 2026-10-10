import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { valuePerSlot } from "../src/analyze/valuePerSlot.js";
import { DEVELOPER_ITEMS, ItemsFile, isKnownId, type Item } from "../src/schema.js";

const file = ItemsFile.parse(JSON.parse(readFileSync("data/items.json", "utf8")));
const byId = new Map(file.items.map((i) => [i.id, i]));
const get = (id: string): Item => {
  const item = byId.get(id);
  if (!item) throw new Error(`Missing item ${id}`);
  return item;
};

describe("data/items.json: structure", () => {
  it("has unique ids", () => {
    expect(byId.size).toBe(file.items.length);
  });

  it("uses only known id forms", () => {
    // A new prefix after a game update needs a decision: extend KNOWN_ID_PATTERN (and the `kind` mapping)
    // or document the exception in KNOWN_ID_QUIRKS.
    const unknown = file.items.filter((i) => !isKnownId(i.id)).map((i) => i.id);
    expect(unknown).toEqual([]);
  });

  it("is sorted by id so diffs stay small", () => {
    const ids = file.items.map((i) => i.id);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  });

  it("has sane prices and cell counts", () => {
    for (const item of file.items) {
      for (const v of item.vendor) {
        expect(v.price, item.id).toBeGreaterThanOrEqual(0); // a few starter and test items are free
        expect(v.amount, item.id).toBeGreaterThanOrEqual(1);
      }
      expect(item.grid[0] * item.grid[1], item.id).toBeLessThanOrEqual(64);
    }
  });
});

describe("data/items.json: unlocks", () => {
  const unlocked = file.items.filter((i) => i.unlock !== null);

  it("uses only known progression trees", () => {
    const roles = new Set(unlocked.map((i) => i.unlock?.role));
    expect([...roles].sort()).toEqual(["Driver", "Infantry", "Medic", "Pilot", "Recon", "Support", "Wardog"]);
  });

  it("has levels in the game's range", () => {
    for (const i of unlocked) expect(i.unlock?.level, i.id).toBeLessThanOrEqual(150);
  });

  it("is not just a 0/1 flag", () => {
    // Regression guard: the vendor tables' LevelToUnlock is only ever 0 or 1 and must not be used as a level.
    expect(new Set(unlocked.map((i) => i.unlock?.level)).size).toBeGreaterThan(10);
  });
});

describe("data/items.json: ids that differ only in case", () => {
  // The game's tags ignore case: the unlock tree and the vendor tables spell `Id.Item.X` for the definition `ID.Item.X`.
  it("canaries: the medical bag unlock and the white smoke grenade price are joined", () => {
    expect(get("ID.Item.MedKit.Standard").unlock).toEqual({ role: "Medic", level: 24, cost: 75000 });
    expect(get("ID.Item.SmokeGrenade.White").vendor.length).toBeGreaterThan(0);
  });
});

describe("data/items.json: display text", () => {
  it("names every vehicle with something other than its id", () => {
    const unnamed = file.items.filter((i) => i.kind === "vehicle" && i.name === i.id).map((i) => i.id);
    expect(unnamed).toEqual([]);
  });

  it("has no padded or CRLF text", () => {
    for (const i of file.items) {
      for (const t of [i.name, i.subtitle, i.description]) {
        if (t === undefined) continue;
        expect(t, i.id).toBe(t.trim());
        expect(t, i.id).not.toContain("\r");
      }
    }
  });

  it("keeps descriptions populated", () => {
    expect(file.items.filter((i) => i.description !== undefined).length).toBeGreaterThanOrEqual(150);
    expect(file.items.filter((i) => i.name === i.id).length).toBeLessThanOrEqual(60);
  });
});

describe("data/items.json: developer items", () => {
  it("flags exactly the declared development items", () => {
    expect(file.items.filter((i) => i.developer).map((i) => i.id).sort()).toEqual(Object.keys(DEVELOPER_ITEMS).sort());
  });

  it("never flags something players can buy or unlock", () => {
    for (const i of file.items.filter((x) => x.developer)) {
      expect(i.vendor, i.id).toEqual([]);
      expect(i.unlock, i.id).toBeNull();
    }
  });

  it("leaves the real items that live in test folders unflagged", () => {
    expect(get("Id.Item.Resuscitator.Standard").developer).toBeUndefined(); // the folder is called ResuscitatorTest
    expect(get("Id.Item.LeapordBarrel").developer).toBeUndefined(); // priced, despite 'Tank Barrel Test'
  });
});

describe("data/items.json: icons", () => {
  it("points every icon at a PNG path inside the icons folder", () => {
    for (const i of file.items) if (i.icon !== undefined) expect(i.icon, i.id).toMatch(/^[A-Za-z0-9_./-]+\.png$/);
  });

  it("gives every vehicle an icon, and keeps most items covered", () => {
    expect(file.items.filter((i) => i.kind === "vehicle" && i.icon === undefined).map((i) => i.id)).toEqual([]);
    expect(file.items.filter((i) => i.icon !== undefined).length).toBeGreaterThanOrEqual(400);
    // Priced items are what players see in shops, so they should all have a picture. The one exception is ammo
    // for the sandbox game mode, which has no UI entry in the game.
    expect(file.items.filter((i) => i.vendor.length > 0 && i.icon === undefined).map((i) => i.id)).toEqual(["ID.Item.155mm.Sandbox"]);
  });

  it("canaries: the inventory icon is chosen, not the killfeed one", () => {
    expect(get("Id.Item.AK74M").icon).toBe("UI/Shared/Icons/Vendor/Weapons/T_UI_Vendor_WEPN_001v2.png");
    expect(get("Vehicle.Variant.Air.Rotary.Havoc.Default").icon).toBe("UI/Shared/Icons/Vehicles/3D/T_UI_Vendor_Havoc.png");
    expect(get("Id.Item.MUZL_013").icon).toBe("UI/Shared/Icons/Vendor/Muzzles/T_UI_Vendor_MZL_013.png");
  });

  it("gives every music tape its icon, from the tape's own `DT_Ext_Entity_UI_*` table", () => {
    const tapes = file.items.filter((i) => i.id.startsWith("Id.Item.MusicTape."));
    expect(tapes.length).toBeGreaterThanOrEqual(9);
    expect(tapes.filter((i) => i.icon === undefined).map((i) => i.id)).toEqual([]);
    expect(get("Id.Item.MusicTape.01").icon).toBe("UI/Shared/Icons/Vendor/Tapes/T_UI_MusicTape_01.png");
    expect(get("Id.Item.MusicTape.01").subtitle).toBe("Music Tape");
    // The game's own table for tape 05 points at tape 06's picture.
    expect(get("Id.Item.MusicTape.05").icon).toBe("UI/Shared/Icons/Vendor/Tapes/T_UI_MusicTape_06.png");
  });

  it("keeps tracer and standard ammo boxes apart", () => {
    const boxes = file.items.map((i) => i.icon).filter((p): p is string => p !== undefined && /ammobox_5_45x39_FMJ/i.test(p));
    expect(new Set(boxes).size).toBe(2);
  });
});

describe("data/items.json: coverage floors", () => {
  // If extraction silently breaks (a format change drops fields), counts fall far below these floors.
  it("keeps the number of items, priced items and vehicles up", () => {
    const priced = file.items.filter((i) => i.vendor.length > 0);
    expect(file.items.length).toBeGreaterThanOrEqual(500);
    expect(priced.length).toBeGreaterThanOrEqual(250);
    expect(file.items.filter((i) => i.kind === "vehicle")).toHaveLength(20);
    expect(file.items.filter((i) => i.unlock !== null).length).toBeGreaterThanOrEqual(200);
  });

  it("keeps stack and grid data populated", () => {
    const stackable = file.items.filter((i) => i.maxStack > 1).length;
    const bigger = file.items.filter((i) => i.grid[0] * i.grid[1] > 1).length;
    expect(stackable).toBeGreaterThanOrEqual(100);
    expect(bigger).toBeGreaterThanOrEqual(150);
  });
});

/**
 * Canaries: values checked by hand against the game. If one fails after a game update, decide whether the
 * game changed the value (update the expectation) or the extraction broke (fix the pipeline).
 */
describe("data/items.json: canaries", () => {
  it("vehicles carry their in-game names", () => {
    expect(get("Vehicle.Variant.Air.Rotary.Havoc.Default")).toMatchObject({ name: "Havoc", description: "2 Seat. Attack Helicopter" });
    expect(get("Vehicle.Variant.Land.Tracked.TNK_01.Heavy")).toMatchObject({ name: "L2A6", subtitle: "Heavy Armored Vehicle" });
    expect(get("Vehicle.Variant.Land.Wheeled.Ural.Default").name).toBe("Ural"); // the shared garage table says "URAL"
  });

  it("item tooltips: AK74 subtitle and stats", () => {
    expect(get("Id.Item.AK74M")).toMatchObject({ subtitle: "Assault Rifle", description: "- Semi / Full Auto\n- 5.45x39mm" });
  });

  it("first aid kit: 800, stacks to 2 (relies on the Stackable default)", () => {
    const kit = get("Id.Item.SuperBandage");
    expect(kit).toMatchObject({ name: "Individual First Aid Kit", grid: [1, 1], maxStack: 2 });
    expect(kit.vendor.map((v) => v.price)).toEqual([800]);
  });

  it("bandage: explicit stack of 5", () => {
    expect(get("Id.Item.Bandage").maxStack).toBe(5);
  });

  it("backpack: 3x3 for 15000", () => {
    const pack = get("Id.Item.BPAK_007");
    expect(pack.grid).toEqual([3, 3]);
    expect(pack.vendor[0]?.price).toBe(15000);
  });

  it("20x102mm ammo is sold 10 at a time for 600 and stacks to 100", () => {
    const ammo = get("Id.Item.20x102mm");
    expect(ammo).toMatchObject({ grid: [2, 2], maxStack: 100 });
    expect(ammo.vendor[0]).toMatchObject({ price: 600, amount: 10 });
  });

  it("muzzle brake: 1x1 for 1600", () => {
    const brake = get("Id.Item.MUZL_048");
    expect(brake.grid).toEqual([1, 1]);
    expect(brake.vendor[0]?.price).toBe(1600);
  });

  it("unlocks: role, minimum level and cash cost", () => {
    expect(get("Id.Item.AK74M").unlock).toEqual({ role: "Infantry", level: 3, cost: 10000 });
    expect(get("Id.Item.MUZL_024").unlock).toEqual({ role: "Infantry", level: 2, cost: 5000 });
    expect(get("Id.Item.Glock17").unlock).toEqual({ role: "Wardog", level: 1, cost: 5000 });
    expect(get("Vehicle.Variant.Air.Rotary.Havoc.Default").unlock).toEqual({ role: "Pilot", level: 35, cost: 500000 });
  });

  it("ranking: first aid kit ties the best single-cell attachment", () => {
    const top = valuePerSlot(file.items);
    const perSlot = (id: string) => top.find((r) => r.id === id)?.perSlot;
    expect(perSlot("Id.Item.SuperBandage")).toBe(1600);
    expect(perSlot("Id.Item.MUZL_048")).toBe(1600);
  });
});
