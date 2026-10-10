import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ItemsFile } from "../src/schema.js";
import { DamageFile } from "../src/schema.gameplay.js";

const damage = DamageFile.parse(JSON.parse(readFileSync("data/damage.json", "utf8")));
const items = ItemsFile.parse(JSON.parse(readFileSync("data/items.json", "utf8"))).items;

describe("data/damage.json: structure and floors", () => {
  it("keeps the model populated", () => {
    expect(damage.rules.length).toBeGreaterThanOrEqual(700);
    expect(new Set(damage.rules.map((r) => r.entity)).size).toBeGreaterThanOrEqual(40);
    expect(damage.hitLocationMultipliers.length).toBeGreaterThanOrEqual(15);
    expect(damage.ammoTypes.length).toBe(6);
    expect(damage.vehicleSeats.length).toBeGreaterThanOrEqual(8);
  });

  it("uses only the operations the schema documents, so a new one after an update is reviewed", () => {
    expect([...new Set(damage.rules.map((r) => r.operation))].sort()).toEqual(["Add", "Percentage_Ongoing"]);
    // Flat additions are tracked vehicles crushing things.
    expect(new Set(damage.rules.filter((r) => r.operation === "Add").map((r) => r.source.join()))).toEqual(new Set(["Vehicle.Land.Tracked"]));
  });

  it("has no rule that does nothing", () => {
    expect(damage.rules.filter((r) => r.operation === "None" && !r.custom)).toEqual([]);
  });

  it("only protects vehicles that exist in items.json", () => {
    const ids = new Set(items.map((i) => i.id.toLowerCase()));
    // The game lists a vehicle (ROT_01) that is not in the game files any more.
    const missing = damage.vehicleSeats.map((v) => v.vehicle).filter((v) => !ids.has(v.toLowerCase()));
    expect(missing.sort()).toEqual(["Vehicle.Variant.Air.Rotary.ROT_01.Default", "Vehicle.Variant.Air.Rotary.ROT_01.MountedMachineGuns"]);
  });

  it("gives every weapon class a full set of body parts", () => {
    const parts = Object.keys(damage.hitLocationMultipliers.find((c) => c.weaponClass === "Universal")!.multipliers).sort();
    expect(parts).toHaveLength(12);
    for (const c of damage.hitLocationMultipliers) expect(Object.keys(c.multipliers).sort(), c.weaponClass).toEqual(parts);
  });
});

/** Values checked by hand against the game's own tables. */
describe("data/damage.json: canaries", () => {
  it("assault rifles do 2.35x to the head and 0.9x to the limbs; snipers 3.2x to the head", () => {
    const get = (c: string) => damage.hitLocationMultipliers.find((x) => x.weaponClass === c)!.multipliers;
    expect(get("Weapon.AR")).toMatchObject({ Head: 2.35, Neck: 2.35, "Torso.Upper": 1, "Arm.Hand": 0.9, "Leg.Foot": 0.9 });
    expect(get("Weapon.Sniper").Head).toBe(3.2);
    expect(get("Universal")).toMatchObject({ Head: 1, Neck: 0.75, "Torso.Upper": 1.1 });
  });

  it("ammo types: hollow point +100% against unarmored people, armor-piercing -20%", () => {
    const rule = (ammo: string) => damage.rules.find((r) => r.entity === "Infantry" && r.category === "AmmoModifier" && r.target.length === 0 && r.source.join() === `Bullet,AmmoModifier.${ammo}`);
    expect(rule("HollowPoint")?.amount).toBe(100);
    expect(rule("ArmorPiercing")?.amount).toBe(-20);
    expect(damage.ammoTypes.find((a) => a.ammoType === "ArmorPiercing")).toMatchObject({ modifier: 0.3, byArmsClass: { Small: 0.7, Medium: 0.6, High: 0.5, Special: 1 } });
  });

  it("armor takes 60% less from bullets and 85% less from explosions", () => {
    const armor = (src: string) => damage.rules.find((r) => r.entity === "Armor" && r.category === "Armor" && r.source.join() === src && r.target.length === 0)!;
    expect(armor("Bullet").amount).toBe(-60);
    expect(armor("Explosive").amount).toBe(-85);
  });

  it("the Havoc takes 95% less from bullets, and protects its crew by 90% from small and medium arms", () => {
    const rule = damage.rules.find((r) => r.entity === "Vehicle.Air.Rotary.Havoc" && r.category === "Armor" && r.source.join() === "Bullet")!;
    expect(rule.amount).toBe(-95);
    const seats = damage.vehicleSeats.find((v) => v.vehicle === "Vehicle.Variant.Air.Rotary.Havoc.Default")!;
    expect(seats.rules[0]).toEqual({ damageSources: ["Small", "Medium"], reduction: -90 });
  });

  it("friendly fire does half damage", () => {
    expect(damage.rules.find((r) => r.alignment === "Friendly" && r.entity === "Infantry" && r.source.join() === "Bullet")?.amount).toBe(-50);
  });
});
