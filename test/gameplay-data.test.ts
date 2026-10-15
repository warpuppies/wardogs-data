import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ItemsFile } from "../src/schema.js";
import { AmmoFile, AttachmentsFile, DamageFile, EquipmentFile, VehiclesFile, WeaponsFile } from "../src/schema.gameplay.js";

const read = (name: string): unknown => JSON.parse(readFileSync(`data/${name}`, "utf8"));
const items = ItemsFile.parse(read("items.json")).items;
// The game matches tags case-insensitively (`Id.Item.SKSBarrel` finds `ID.Item.SKSBarrel`), so ids are compared that way.
const itemIds = new Set(items.map((i) => i.id.toLowerCase()));
const { projectiles } = AmmoFile.parse(read("ammo.json"));
const { weapons } = WeaponsFile.parse(read("weapons.json"));
const { attachments } = AttachmentsFile.parse(read("attachments.json"));
const { vehicles } = VehiclesFile.parse(read("vehicles.json"));

const weapon = (id: string) => weapons.find((w) => w.id === id)!;
const projectile = (id: string) => projectiles.find((p) => p.id === id)!;
const attachment = (id: string) => attachments.find((a) => a.id === id)!;

describe("gameplay data: structure", () => {
  it("is sorted and unique, so diffs stay small", () => {
    for (const list of [weapons, attachments, vehicles]) {
      const ids = list.map((x) => x.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
    }
    // Two projectile definitions can share a caliber id (a debug rocket reuses 84mm), so assets are the key.
    expect(new Set(projectiles.map((p) => p.asset)).size).toBe(projectiles.length);
  });

  // Slots in the game's own data that allow items which have no definition in the game files.
  const DANGLING = ["Id.Item.RK3PistolGrip", "Id.Item.SKSPistolGrip", "Id.Item.IRNS_002"];

  it("only refers to ids that exist in items.json", () => {
    const missing = [
      ...weapons.map((w) => w.id),
      ...attachments.map((a) => a.id),
      ...vehicles.map((v) => v.id),
      ...projectiles.flatMap((p) => p.items),
      ...weapons.flatMap((w) => w.slots.flatMap((s) => [...s.items, ...(s.default ? [s.default] : [])])),
    ].filter((id) => !itemIds.has(id.toLowerCase()));
    expect([...new Set(missing)].sort()).toEqual([...DANGLING].sort());
  });

  it("gives every vehicle in items.json its stats", () => {
    const withStats = new Set(vehicles.map((v) => v.id));
    expect(items.filter((i) => i.kind === "vehicle" && !withStats.has(i.id)).map((i) => i.id)).toEqual([]);
  });

  it("has a projectile for every caliber a weapon fires (a caliber also covers its sub-tags, such as 12g.RifledSlug)", () => {
    const known = projectiles.map((p) => p.id.replace("Item.Caliber.", ""));
    const unknown = weapons.flatMap((w) => w.calibers.filter((c) => !known.some((k) => k === c || k.startsWith(`${c}.`))).map((c) => `${w.id}: ${c}`));
    expect(unknown).toEqual([]);
  });

  it("keeps modifier values sane", () => {
    for (const a of attachments) {
      for (const m of [...a.modifiers, ...a.characterModifiers]) {
        if (m.op === "multiplyCompound" || m.op === "multiply") expect(m.value, `${a.id} ${m.attribute}`).toBeGreaterThan(0);
        expect(m.value, `${a.id} ${m.attribute}`).not.toBe(m.op === "add" ? 0 : 1);
      }
    }
  });
});

describe("gameplay data: vehicle health and fuel", () => {
  it("gives every vehicle health and a damage entity that has rules in damage.json", () => {
    const entities = new Set(DamageFile.parse(read("damage.json")).rules.map((r) => r.entity));
    expect(vehicles.filter((v) => !v.health).map((v) => v.id)).toEqual([]);
    expect(vehicles.filter((v) => !v.damageEntity || !entities.has(v.damageEntity)).map((v) => v.id)).toEqual([]);
  });

  it("agrees with the shop: fuel economy is 1 / kmPerLiter, rounded to one decimal", () => {
    // The TNK_04's stats say 8.5 while its systems asset (the shop's source) gives 0.14375 km per liter, which is 7: the game disagrees with itself.
    const disagrees = new Set(["Vehicle.Variant.Land.Tracked.TNK_04.Default"]);
    for (const v of vehicles) if (v.kmPerLiter && !disagrees.has(v.id)) expect(v.fuelEconomy, v.id).toBeCloseTo(Math.round(10 / v.kmPerLiter) / 10, 1);
  });
});

describe("gameplay data: names", () => {
  it("carries the name items.json has for every weapon, attachment, vehicle and armor piece", () => {
    const names = new Map(ItemsFile.parse(read("items.json")).items.map((i) => [i.id, i.name]));
    const { armor } = EquipmentFile.parse(read("equipment.json"));
    for (const list of [weapons, attachments, vehicles, armor]) {
      expect(list.length).toBeGreaterThan(0);
      for (const x of list) expect(x.name, x.id).toBe(names.get(x.id));
    }
    expect(weapons.find((w) => w.id === "Id.Item.AK74M")?.name).toBe("AK74");
  });
});

describe("gameplay data: vehicle weapon icons", () => {
  it("names only weapons the vehicle lists, with icons that are in the icon manifest", () => {
    const listed = new Set((JSON.parse(readFileSync("assets/icons.manifest.json", "utf8")) as { files: Array<{ path: string }> }).files.map((f) => f.path));
    for (const v of vehicles) for (const [name, icon] of Object.entries(v.weaponIcons ?? {})) {
      expect(v.weapons, v.id).toContain(name);
      expect(listed.has(icon), `${v.id} ${name}`).toBe(true);
    }
    expect(vehicles.filter((v) => v.weaponIcons).length).toBeGreaterThanOrEqual(6);
  });

  it("canaries: the Havoc's rocket pods use the rocket pod icon and its autocannon the autocannon icon", () => {
    const havoc = vehicles.find((v) => v.id === "Vehicle.Variant.Air.Rotary.Havoc.Default")!;
    expect(havoc.weaponIcons).toEqual({
      "2A42 Autocannon": "UI/Shared/Icons/Vehicles/3D/T_UI_Vehicle_WPN_AutoCannon.png",
      "B-13 Rocket Pods": "UI/Shared/Icons/Vehicles/3D/T_UI_Vehicle_WPN_RocketPod.png",
    });
  });
});

describe("gameplay data: coverage floors", () => {
  // If extraction silently breaks (a format change drops fields), counts fall far below these floors.
  it("keeps the number of entries up", () => {
    expect(weapons.length).toBeGreaterThanOrEqual(30);
    expect(projectiles.length).toBeGreaterThanOrEqual(30);
    expect(attachments.length).toBeGreaterThanOrEqual(250);
    expect(attachments.filter((a) => a.modifiers.length > 0).length).toBeGreaterThanOrEqual(80);
    expect(attachments.filter((a) => a.magazine).length).toBeGreaterThanOrEqual(50);
    expect(vehicles).toHaveLength(23);
  });

  it("keeps weapon stats populated", () => {
    expect(weapons.filter((w) => w.rpm !== undefined).length).toBeGreaterThanOrEqual(30);
    expect(weapons.filter((w) => w.muzzleVelocity !== undefined).length).toBeGreaterThanOrEqual(30);
    expect(weapons.filter((w) => w.recoil !== undefined).length).toBeGreaterThanOrEqual(18);
    expect(weapons.filter((w) => w.damageFalloff !== undefined).length).toBeGreaterThanOrEqual(20);
  });
});

/** Values checked by hand against the game's own data. A failure after an update means the game changed or the pipeline broke. */
describe("gameplay data: canaries", () => {
  it("AK74M: 650 rpm, 880 m/s, 5.45mm, full damage to 500 m then falling to 20% at 1200 m", () => {
    const ak = weapon("Id.Item.AK74M");
    expect(ak).toMatchObject({ rpm: 650, muzzleVelocity: 880, calibers: ["545mm"], effectiveRange: 500, fireModes: ["Automatic", "SemiAutomatic"] });
    expect(ak.damageFalloff).toEqual([
      { distance: 0, multiplier: 1 },
      { distance: 500, multiplier: 1 },
      { distance: 1200, multiplier: 0.2 },
    ]);
    expect(ak.recoil?.pattern).toHaveLength(30);
    expect(ak.slots.find((s) => s.slot === "Magazine")?.default).toBe("Id.Item.AK74MMagazine");
  });

  it("ammo: 5.45 does 26 and 5.56 does 28, with the 5.56 bullet weighing 4.1 g", () => {
    expect(projectile("Item.Caliber.545mm").damage).toBe(26);
    const r = projectile("Item.Caliber.556mm");
    expect(r).toMatchObject({ damage: 28, massKg: 0.0041, diameterMm: 5.7, drag: { coefficient: 1.26, model: "G7 (Boat Tail)" } });
    expect(r.items).toContain("Id.Item.556mm.ArmorPiercing");
  });

  it("falloff: the AK74M's curve is linear, while some SMG curves use cubic segments", () => {
    expect(weapon("Id.Item.AK74M").damageFalloff?.every((p) => p.interpolation === undefined)).toBe(true);
    const cubic = weapons.filter((w) => w.damageFalloff?.some((p) => p.interpolation === "Cubic")).map((w) => w.id);
    expect(cubic.length).toBeGreaterThanOrEqual(4);
    expect(cubic).toContain("Id.Item.MP9");
  });

  it("magazine: the standard AK74 magazine holds 30 rounds of 5.45mm", () => {
    expect(attachment("Id.Item.AK74MMagazine").magazine).toEqual({ capacity: 30, calibers: ["545mm"] });
  });

  it("muzzle device: a flash hider tightens spread by 1% and speeds aiming by 2%", () => {
    expect(attachment("Id.Item.MUZL_013").modifiers).toEqual([
      { attribute: "Weapon.SpreadMultiplier", op: "multiplyCompound", value: 0.99 },
      { attribute: "Weapon.AimTime", op: "multiplyCompound", value: 0.98 },
    ]);
  });

  it("vehicle health: Bobcat 200, Humvee 500, Havoc 800, Ural 700", () => {
    const hp = (id: string) => vehicles.find((v) => v.id === id)!.health?.initial;
    expect(hp("Vehicle.Variant.Land.Wheeled.Bobcat.Default")).toBe(200);
    expect(hp("Vehicle.Variant.Land.Wheeled.Humvee.Minigun")).toBe(500);
    expect(hp("Vehicle.Variant.Air.Rotary.Havoc.Default")).toBe(800);
    expect(hp("Vehicle.Variant.Land.Wheeled.Ural.Attack")).toBe(700);
    expect(vehicles.find((v) => v.id === "Vehicle.Variant.Land.Wheeled.Kodiak.Pickup")?.damageEntity).toBe("Vehicle.Land.Wheeled.Patriot.Kodiak");
  });

  it("vehicle mass: Bobcat 250, Kodiak 2750, Humvee 7250, Ural 10000, Havoc 7500", () => {
    const mass = (id: string) => vehicles.find((v) => v.id === id)!.mass;
    expect(mass("Vehicle.Variant.Land.Wheeled.Bobcat.Default")).toBe(250);
    expect(mass("Vehicle.Variant.Land.Wheeled.Kodiak.Pickup")).toBe(2750);
    expect(mass("Vehicle.Variant.Land.Wheeled.Humvee.Minigun")).toBe(7250);
    expect(mass("Vehicle.Variant.Land.Wheeled.Ural.Attack")).toBe(10000);
    expect(mass("Vehicle.Variant.Air.Rotary.Havoc.Default")).toBe(7500);
  });

  it("gives every wheeled vehicle and helicopter a mass, and every wheeled and tracked vehicle an engine and gearbox", () => {
    const flying = (v: { id: string }) => v.id.startsWith("Vehicle.Variant.Air.");
    const tracked = (v: { id: string }) => v.id.startsWith("Vehicle.Variant.Land.Tracked.");
    expect(vehicles.filter((v) => !tracked(v) && !v.mass).map((v) => v.id)).toEqual([]);
    expect(vehicles.filter((v) => !flying(v) && (!v.engine || !v.transmission)).map((v) => v.id)).toEqual([]);
    for (const v of vehicles.filter((v) => v.engine)) expect(v.engine!.torqueCurve.length, v.id).toBeGreaterThan(2);
  });

  it("Humvee engine: 700 to 4000 rpm, peak torque 1450, six gears and a 6.54 final drive", () => {
    const humvee = vehicles.find((v) => v.id === "Vehicle.Variant.Land.Wheeled.Humvee.Default")!;
    expect(humvee.engine).toMatchObject({ idleRpm: 700, limitRpm: 4000 });
    expect(Math.max(...humvee.engine!.torqueCurve.map((k) => k.torque))).toBe(1450);
    expect(humvee.transmission).toMatchObject({ gearRatios: [3.6, 2.4, 1.7, 1.35, 1.12, 3.6], finalGearRatio: 6.54 });
  });

  it("variants of one platform share their physics", () => {
    const get = (id: string) => vehicles.find((v) => v.id === id)!;
    const physics = (id: string) => { const { mass, engine, transmission } = get(id); return { mass, engine, transmission }; };
    expect(physics("Vehicle.Variant.Land.Wheeled.Humvee.MachineGun")).toEqual(physics("Vehicle.Variant.Land.Wheeled.Humvee.Default"));
    expect(physics("Vehicle.Variant.Land.Wheeled.Ural.Attack")).toEqual(physics("Vehicle.Variant.Land.Wheeled.Ural.Default"));
  });

  it("vehicles: Havoc 400 km/h with 2 seats, Humvee 4 seats", () => {
    const get = (id: string) => vehicles.find((v) => v.id === id)!;
    expect(get("Vehicle.Variant.Air.Rotary.Havoc.Default")).toMatchObject({ maxSpeed: 400, maxFuel: 130, seats: 2 });
    expect(get("Vehicle.Variant.Land.Wheeled.Humvee.Default").seats).toBe(4);
  });
});

describe("equipment data", () => {
  const equipment = EquipmentFile.parse(read("equipment.json"));

  it("refers only to items in items.json", () => {
    expect(equipment.armor.filter((a) => !itemIds.has(a.id.toLowerCase())).map((a) => a.id)).toEqual([]);
  });

  it("keeps armor and weight classes populated, lightest class first", () => {
    expect(equipment.armor.length).toBeGreaterThanOrEqual(10);
    expect(equipment.weightClasses.map((w) => w.name)).toEqual(["Lightest", "Light", "Medium", "Heavy", "SuperHeavy"]);
    expect(equipment.weightClasses.map((w) => w.minWeightKg)).toEqual([0, 10, 17, 27, 40]);
  });

  it("canaries: heavy armor covers the torso, takes 250 hits worth and absorbs 50%; heavy weight slows to 80%", () => {
    const heavy = equipment.armor.find((a) => a.id === "Id.Item.HeavyArmor")!;
    expect(heavy).toMatchObject({ slot: "Armor", damageContext: "Armor.Heavy", durability: 250 });
    expect(heavy.coveredLocations.sort()).toEqual(["Torso.Lower", "Torso.Middle", "Torso.Upper"]);
    expect(heavy.stages.every((s) => s.damageReduction === 50)).toBe(true);
    expect(equipment.armor.find((a) => a.id === "Id.Item.HeavyHelmet")?.coveredLocations.sort()).toEqual(["Head", "Neck"]);
    const speed = equipment.weightClasses.find((w) => w.name === "Heavy")!.modifiers.find((m) => m.attribute === "Movement.MaxSpeedMultiplier");
    expect(speed).toEqual({ attribute: "Movement.MaxSpeedMultiplier", op: "multiplyCompound", value: 0.8 });
  });

  it("armor targets match the damage rules' target tags", () => {
    const damage = DamageFile.parse(read("damage.json"));
    const targets = new Set(damage.rules.flatMap((r) => r.target));
    // Every armor class that a rule names should be one an item can give (the converse need not hold).
    for (const t of targets) if (/^(Armor|Helmet)\.(Light|Medium|Heavy|SuperHeavy)$/.test(t)) expect(equipment.armor.map((a) => a.damageContext), t).toContain(t);
  });
});
