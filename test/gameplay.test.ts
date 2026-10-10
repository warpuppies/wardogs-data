import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildGameplayData,
  parseArmor,
  parseAttachment,
  parseMagazine,
  parseModifiers,
  parseProjectile,
  parseSlots,
  parseVehiclePhysics,
  parseVehicleStats,
  parseVehicleSystems,
  resolveSystemsEntity,
  parseWeapon,
  parseWeightClasses,
  type ItemDefinition,
} from "../src/transform/gameplay.js";
import type { RawExport } from "../src/transform/items.js";
import { assetPath, packageKey, PackageIndex } from "../src/transform/packages.js";
import { writeCacheMeta } from "../src/cache.js";
import { writeGameplayFixture } from "./gameplayFixture.js";

const fixed = (value: number) => ({ Scalar: { Value: value, Curve: { CurveTable: null, RowName: "None" } }, CurveIndexing: "EBHAttributeScalarIndex::Fixed" });
const mod = (attribute: string, op: string, modifier: unknown) => ({ Attribute: { TagName: `Attribute.Gameplay.${attribute}` }, Operation: `EBHAttributeModOp::${op}`, Modifier: modifier });

describe("parseProjectile", () => {
  const exp = (stats: unknown): RawExport => ({ Type: "WDProjectileData", Properties: { ProjectileId: { TagName: "Item.Caliber.1mm" }, ProjectileStats: stats as never } });

  it("converts units: centimeters to meters and millimeters, cm/s to m/s", () => {
    const p = parseProjectile(
      exp({
        DamageValues: { BaseDamage: 28, ExplosiveRadius: 1000, EffectiveExplosiveRadius: 500 },
        ProjectileDimensions: { Length: 1.2696, Diameter: 0.57, Mass: 0.0041, DragModel: { Value: 1.26, Curve: { RowName: "G7" } } },
        TypicalSpeed: 40400,
        ThrustSpeed: 22000,
      }),
      "Content/DA_X",
    );
    expect(p).toMatchObject({
      id: "Item.Caliber.1mm",
      damage: 28,
      massKg: 0.0041,
      diameterMm: 5.7,
      lengthMm: 12.696,
      drag: { coefficient: 1.26, model: "G7" },
      typicalSpeed: 404,
      explosive: { radius: 10, effectiveRadius: 5 },
      propulsion: { thrustSpeed: 220 },
      items: [],
    });
  });

  it("leaves out groups the game does not define", () => {
    const p = parseProjectile(exp({ DamageValues: { BaseDamage: 5 } }), "Content/DA_X");
    expect(p).toEqual({ id: "Item.Caliber.1mm", asset: "Content/DA_X", damageContext: [], damage: 5, items: [] });
  });

  it("ignores a drag curve named None", () => {
    const p = parseProjectile(exp({ DamageValues: { BaseDamage: 5 }, ProjectileDimensions: { DragModel: { Value: 0.2, Curve: { RowName: "None" } } } }), "x");
    expect(p?.drag).toEqual({ coefficient: 0.2 });
  });

  it("returns null without an id or a damage value", () => {
    expect(parseProjectile({ Type: "WDProjectileData", Properties: {} }, "x")).toBeNull();
    expect(parseProjectile(exp({}), "x")).toBeNull();
  });
});

describe("parseSlots", () => {
  const slotExport = (container: unknown): RawExport[] => [{ Type: "BHInventoryFragment_SubSlotSupport", Properties: { Containers: [container] as never } }];

  it("reads the filter, default item and hidden flag, and shortens attachment tags", () => {
    const slots = parseSlots(
      slotExport({
        ContainerIdentifier: { TagName: "Item.Attachment.Sight" },
        Filter: { SupportFilter: "EBHSupportFilterMethod::BlockPriority", AllowedSubSlotItems: ["Id.Item.A"], AllowedSubSlotContext: ["Item.Attachment.Sight.Short"], BlockedSubSlotItems: ["Id.Item.B"], BlockedSubSlotContext: [] },
        bIsHiddenContainer: false,
        DefaultItems: ["Id.Item.A"],
      }),
    );
    expect(slots).toEqual([
      { slot: "Sight", items: ["Id.Item.A"], contexts: ["Item.Attachment.Sight.Short"], filter: "BlockPriority", blockedItems: ["Id.Item.B"], blockedContexts: [], default: "Id.Item.A", hidden: false },
    ]);
  });

  it("keeps other tags whole and omits the default when there is none", () => {
    const [slot] = parseSlots(slotExport({ ContainerIdentifier: { TagName: "Item.Ammo" }, Filter: {}, bIsHiddenContainer: true, DefaultItems: [] }));
    expect(slot?.slot).toBe("Item.Ammo");
    expect(slot).not.toHaveProperty("default");
    expect(slot?.hidden).toBe(true);
  });
});

describe("parseWeapon", () => {
  const stats = (weaponStats: unknown): RawExport => ({ Type: "WDWeaponStatsData", Properties: { WeaponStats: weaponStats as never } });

  it("converts speed and falloff distance to meters and strips tag prefixes", () => {
    const w = parseWeapon(
      "Id.Item.Gun",
      stats({
        RoundsPerMinute: 650,
        SupportedFireModes: ["EWDFireMode::Automatic"],
        SupportedCaliber: ["Item.Caliber.545mm"],
        InitialBulletSpeed: 88000,
        EffectiveRange: 500,
        bUseDistanceDamageFalloffCurve: true,
        DistanceDamageFalloffCurve: { EditorCurveData: { Keys: [{ Time: 0, Value: 1 }, { Time: 120000, Value: 0.2 }] } },
      }),
      "A/DA_Gun",
      [],
    );
    expect(w).toMatchObject({
      fireModes: ["Automatic"],
      rpm: 650,
      calibers: ["545mm"],
      muzzleVelocity: 880,
      effectiveRange: 500,
      damageFalloff: [{ distance: 0, multiplier: 1 }, { distance: 1200, multiplier: 0.2 }],
    });
  });

  it("keeps the interpolation of a falloff point when it is not linear", () => {
    const w = parseWeapon(
      "Id.Item.Gun",
      stats({
        bUseDistanceDamageFalloffCurve: true,
        DistanceDamageFalloffCurve: { EditorCurveData: { Keys: [{ Time: 0, Value: 1, InterpMode: "RCIM_Linear" }, { Time: 10000, Value: 1, InterpMode: "RCIM_Cubic" }, { Time: 20000, Value: 0.6, InterpMode: "RCIM_Constant" }] } },
      }),
      "A",
      [],
    );
    expect(w.damageFalloff).toEqual([
      { distance: 0, multiplier: 1 },
      { distance: 100, multiplier: 1, interpolation: "Cubic" },
      { distance: 200, multiplier: 0.6, interpolation: "Constant" },
    ]);
  });

  it("ignores the falloff curve unless the weapon uses it", () => {
    const w = parseWeapon("Id.Item.Gun", stats({ bUseDistanceDamageFalloffCurve: false, DistanceDamageFalloffCurve: { EditorCurveData: { Keys: [{ Time: 0, Value: 1 }] } } }), "A", []);
    expect(w.damageFalloff).toBeUndefined();
  });

  it("reads the recoil pattern, shotgun data and zeroing", () => {
    const w = parseWeapon(
      "Id.Item.Gun",
      stats({
        RecoilPattern: [{ X: 0.1, Y: 0.7 }, { Y: 0.9 }],
        PostPatternRandomPitchRecoil: { X: 0.4, Y: 0.8 },
        ShotgunData: { ChokeFactor: 0.5, RandomConeHalfAngleRange: { X: 0, Y: 2 } },
        MinZeroingRange: 25,
        MaxZeroingRange: 100,
      }),
      "A",
      [],
    );
    expect(w.recoil).toEqual({ pattern: [{ x: 0.1, y: 0.7 }, { x: 0, y: 0.9 }], afterPatternPitch: [0.4, 0.8] });
    expect(w.shotgun).toEqual({ chokeFactor: 0.5, randomConeHalfAngleRange: [0, 2] });
    expect(w.zeroing).toEqual({ min: 25, max: 100 });
  });

  it("omits recoil, shotgun and zeroing when the stats have none", () => {
    const w = parseWeapon("Id.Item.Gun", stats({ RoundsPerMinute: 60 }), "A", []);
    expect(w).not.toHaveProperty("recoil");
    expect(w).not.toHaveProperty("shotgun");
    expect(w).not.toHaveProperty("zeroing");
  });
});

describe("parseModifiers", () => {
  it("keeps fixed values with their operation and drops the attribute prefix", () => {
    const { modifiers, skipped } = parseModifiers([{ Type: "GE_C", Properties: { Modifiers: [mod("Weapon.AimTime", "MultiplyCompound", fixed(1.1)), mod("Character.Weight", "Add", fixed(0.5))] } }]);
    expect(modifiers).toEqual([
      { attribute: "Weapon.AimTime", op: "multiplyCompound", value: 1.1 },
      { attribute: "Character.Weight", op: "add", value: 0.5 },
    ]);
    expect(skipped).toBe(0);
  });

  it("drops modifiers that change nothing", () => {
    const { modifiers } = parseModifiers([{ Type: "GE_C", Properties: { Modifiers: [mod("A", "MultiplyCompound", fixed(1)), mod("B", "Multiply", fixed(1)), mod("C", "Add", fixed(0)), mod("D", "Override", fixed(1))] } }]);
    expect(modifiers.map((m) => m.attribute)).toEqual(["D"]); // overriding to 1 is a change
  });

  it("counts, but does not include, modifiers whose value is computed at runtime", () => {
    const curve = { Scalar: { Value: 1, Curve: { CurveTable: { ObjectPath: "/Game/T" }, RowName: "Row" } }, CurveIndexing: "EBHAttributeScalarIndex::Fixed" };
    const dynamic = { DataTag: { TagName: "X" }, Coefficient: 1 };
    const { modifiers, skipped } = parseModifiers([{ Type: "GE_C", Properties: { Modifiers: [mod("A", "Add", curve), mod("B", "Add", dynamic)] } }]);
    expect(modifiers).toEqual([]);
    expect(skipped).toBe(2);
  });

  it("returns nothing for a package without modifiers", () => {
    expect(parseModifiers([{ Type: "BlueprintGeneratedClass", Properties: {} }])).toEqual({ modifiers: [], skipped: 0 });
  });
});

const magazineExports = (capacity: number | undefined, contexts: string[]): RawExport[] => [
  {
    Type: "BHInventoryFragment_SubSlotSupport",
    Properties: {
      Containers: [
        { ContainerIdentifier: { TagName: "Item.Ammo" }, Filter: { AllowedSubSlotContext: contexts }, MaxSlotAmountStackSize: capacity, bIsHiddenContainer: true },
      ] as never,
    },
  },
];

describe("parseMagazine", () => {
  it("reads capacity and calibers", () => {
    expect(parseMagazine(magazineExports(30, ["Item.Caliber.545mm", "Item.Other"]))).toEqual({ capacity: 30, calibers: ["545mm"] });
  });

  it("is absent without an ammo container or a capacity", () => {
    expect(parseMagazine([])).toBeUndefined();
    expect(parseMagazine(magazineExports(undefined, ["Item.Caliber.545mm"]))).toBeUndefined();
  });
});

describe("parseAttachment", () => {
  const def = (extra: RawExport[]): ItemDefinition => ({
    id: "Id.Item.Mag",
    asset: "A/ID_Mag",
    exports: [{ Type: "BHInventoryItemDefinition", Properties: { ItemId: { TagName: "Id.Item.Mag" }, ItemContext: ["Item.Attachment.Magazine"] } }, ...extra],
  });
  const attachmentFragment = (data: unknown): RawExport => ({ Type: "WDInventoryFragment_Attachment", Properties: { AttachmentData: data as never } });

  it("joins the attachment with the modifiers of its effects", () => {
    const index = { load: (path: string | null | undefined) => (path === "/Game/GE_A.0" ? [{ Type: "GE_C", Properties: { Modifiers: [mod("Weapon.AimTime", "MultiplyCompound", fixed(0.9))] } } as RawExport] : undefined) };
    const result = parseAttachment(
      def([attachmentFragment({ AttachmentType: { TagName: "Item.Attachment.Magazine" }, AppliedEffects: [{ ObjectPath: "/Game/GE_A.0" }, { ObjectPath: "/Game/Missing.0" }] }), ...magazineExports(20, ["Item.Caliber.1mm"])]),
      index,
    );
    expect(result?.attachment).toEqual({
      id: "Id.Item.Mag",
      type: "Magazine",
      contexts: ["Item.Attachment.Magazine"],
      modifiers: [{ attribute: "Weapon.AimTime", op: "multiplyCompound", value: 0.9 }],
      characterModifiers: [],
      magazine: { capacity: 20, calibers: ["1mm"] },
    });
  });

  it("returns null for items that are not attachments", () => {
    expect(parseAttachment(def([]), { load: () => undefined })).toBeNull();
  });
});

describe("parseVehicleStats", () => {
  const text = (value: string) => ({ LocalizedString: value, SourceString: value });

  it("reads speed, fuel, seats and the shop's equipment names", () => {
    const v = parseVehicleStats(
      "Vehicle.Variant.Test",
      { Type: "WDVehicleStatsDataAsset", Properties: { MaxSpeed: 120, MaxFuel: 60, FuelEconomy: 3.5, MaxSeats: 4, VehicleWeaponryNames: [text("Cannon ")] as never } },
      "A/DA",
    );
    expect(v).toEqual({ id: "Vehicle.Variant.Test", asset: "A/DA", maxSpeed: 120, maxFuel: 60, fuelEconomy: 3.5, seats: 4, weapons: ["Cannon"], counterMeasures: [] });
  });

  it("returns null when a required number is missing", () => {
    expect(parseVehicleStats("V", { Type: "WDVehicleStatsDataAsset", Properties: { MaxSpeed: 1 } }, "A")).toBeNull();
  });
});

describe("packages", () => {
  it("maps cache paths to the object paths the game uses", () => {
    expect(packageKey("/Wardogs/Content/Ammo/DA_X.json")).toBe("/Game/Ammo/DA_X");
    expect(packageKey("/Wardogs/Plugins/GameFeatures/Weapons/Platforms/WEPN_001/Content/Data/DA_Y.json")).toBe("/WEPN_001/Data/DA_Y");
    expect(packageKey("/Wardogs/Plugins/BHFramework/Content/Z.json")).toBe("/BHFramework/Z");
    expect(packageKey("/Other/Thing.json")).toBeNull();
  });

  it("turns a cache path into the asset path used in the data", () => {
    expect(assetPath("/Wardogs/Content/Ammo/DA_X.json")).toBe("Content/Ammo/DA_X");
  });

  it("loads packages by object path, ignoring case and the export index", () => {
    const raw = mkdtempSync(join(tmpdir(), "wardogs-index-"));
    writeCacheMeta(raw, { gameBuild: "1", cue4parse: "x" });
    writeGameplayFixture(raw);
    const index = new PackageIndex([join(raw, "items"), join(raw, "gameplay")]);
    expect(index.loadExport("/GUN_01/Data/DA_Gun_Stats.0", "WDWeaponStatsData")).toBeDefined();
    expect(index.loadExport("/game/ammo/da_100mm_projectiledata.3", "WDProjectileData")).toBeDefined();
    expect(index.asset("/GUN_01/Data/DA_Gun_Stats.0")).toBe("Plugins/GameFeatures/Guns/GUN_01/Content/Data/DA_Gun_Stats");
    expect(index.load("/Game/Nothing.0")).toBeUndefined();
    expect(index.load(undefined)).toBeUndefined();
    expect([...index.findAll("WDProjectileData")]).toHaveLength(1);
  });
});

describe("buildGameplayData", () => {
  const build = () => {
    const raw = mkdtempSync(join(tmpdir(), "wardogs-gameplay-"));
    writeGameplayFixture(raw);
    return buildGameplayData(raw, "100");
  };
  const file = (files: { path: string; content: string }[], path: string) => JSON.parse(files.find((f) => f.path === path)!.content);

  it("joins ammo with the items that fire it", () => {
    const { projectiles } = file(build().files, "data/ammo.json");
    expect(projectiles).toHaveLength(1);
    expect(projectiles[0]).toMatchObject({ id: "Item.Caliber.100mm", damage: 33, items: ["Id.Item.100mm"] });
  });

  it("builds weapons from the item's stats link and slots", () => {
    const { weapons, units } = file(build().files, "data/weapons.json");
    expect(units).toBe("meters");
    expect(weapons).toHaveLength(1);
    expect(weapons[0]).toMatchObject({
      id: "Id.Item.Gun",
      rpm: 600,
      calibers: ["100mm"],
      muzzleVelocity: 900,
      damageFalloff: [{ distance: 0, multiplier: 1 }, { distance: 400, multiplier: 1 }, { distance: 1000, multiplier: 0.5 }],
    });
    expect(weapons[0].slots.map((s: { slot: string }) => s.slot)).toEqual(["Magazine", "Chamber"]);
  });

  it("builds attachments with capacity and modifiers, dropping no-ops", () => {
    const { attachments } = file(build().files, "data/attachments.json");
    expect(attachments).toEqual([
      {
        id: "Id.Item.GunMag",
        name: "Test Mag",
        type: "Magazine",
        contexts: ["Item.Attachment.Magazine"],
        modifiers: [{ attribute: "Weapon.AimTime", op: "multiplyCompound", value: 1.1 }],
        characterModifiers: [],
        magazine: { capacity: 17, calibers: ["100mm"] },
      },
    ]);
  });

  it("builds vehicles from the shop rows that name a stats asset", () => {
    const { vehicles } = file(build().files, "data/vehicles.json");
    expect(vehicles).toEqual([
      { id: "Vehicle.Variant.Test", asset: "Plugins/GameFeatures/Vehicles/VEH_01/Content/Data/DA_Veh_Stats", maxSpeed: 120, maxFuel: 60, fuelEconomy: 3.5, seats: 4, weapons: ["Test Cannon"], counterMeasures: [] },
    ]);
  });

  it("is deterministic", () => {
    expect(build().files).toEqual(build().files);
  });

  it("fails clearly when the gameplay cache was never extracted", () => {
    expect(() => buildGameplayData(mkdtempSync(join(tmpdir(), "wardogs-empty-")), "1")).toThrow(/pnpm extract gameplay/);
  });
});

describe("parseArmor", () => {
  const armorDef = (extra: RawExport[]): ItemDefinition => ({
    id: "Id.Item.Plate",
    asset: "A/ID_Plate",
    exports: [{ Type: "BHInventoryItemDefinition", Properties: { ItemId: { TagName: "Id.Item.Plate" }, ItemContext: ["Inventory.Slot.Armor", "Item.Context.Equippable"] } }, ...extra],
  });
  const fragmentOf = (p: unknown): RawExport => ({ Type: "WDInventoryFragment_Armor", Properties: p as never });

  it("reads coverage, durability, wear stages and the wearer effects", () => {
    const index = { load: (path: string | null | undefined) => (path === "/Game/GE_Slow.0" ? [{ Type: "GE_C", Properties: { Modifiers: [mod("Movement.MaxSpeedMultiplier", "MultiplyCompound", fixed(0.9))] } } as RawExport] : undefined) };
    const result = parseArmor(
      armorDef([
        fragmentOf({
          DamageContextTag: { TagName: "Meta.Damage.Armor.Heavy" },
          CoveredHitLocations: ["Meta.Damage.HitLocation.Infantry.Torso.Upper"],
          ReplicatedData: { Durability: 250 },
          DurabilityStagesSetupData: [{ DamagePercentageReduction: 55, Thickness: 1, Density: 100 }, { DamagePercentageReduction: 55, Thickness: 1, Density: 60 }],
          AppliedEffects: [{ ObjectPath: "/Game/GE_Slow.0" }],
        }),
      ]),
      index,
    );
    expect(result?.armor).toEqual({
      id: "Id.Item.Plate",
      slot: "Armor",
      damageContext: "Armor.Heavy",
      coveredLocations: ["Torso.Upper"],
      durability: 250,
      stages: [{ damageReduction: 55, thickness: 1, density: 100 }, { damageReduction: 55, thickness: 1, density: 60 }],
      modifiers: [{ attribute: "Movement.MaxSpeedMultiplier", op: "multiplyCompound", value: 0.9 }],
    });
  });

  it("returns null for items without an armor fragment, a damage context or a slot", () => {
    const none = { load: () => undefined };
    expect(parseArmor(armorDef([]), none)).toBeNull();
    expect(parseArmor(armorDef([fragmentOf({})]), none)).toBeNull();
    expect(parseArmor({ id: "x", asset: "x", exports: [fragmentOf({ DamageContextTag: { TagName: "Meta.Damage.Armor.Light" } })] }, none)).toBeNull();
  });
});

describe("parseWeightClasses", () => {
  it("converts grams to kilograms, sorts lightest first and attaches effect modifiers", () => {
    const effect = [{ Type: "GE_C", Properties: { Modifiers: [mod("Movement.MaxSpeedMultiplier", "MultiplyCompound", fixed(0.8))] } } as RawExport];
    const exp: RawExport = {
      Type: "WDMoverWeightData",
      Properties: {
        WeightClasses: [
          { Key: { TagName: "State.Player.Weight.Heavy" }, Value: { MinWeight: 27000, Effect: { ObjectPath: "/Game/GE_Heavy.0" } } },
          { Key: { TagName: "State.Player.Weight.Lightest" }, Value: { MinWeight: 0, Effect: null } },
        ] as never,
      },
    };
    const classes = parseWeightClasses(exp, { load: (p) => (p === "/Game/GE_Heavy.0" ? effect : undefined) });
    expect(classes).toEqual([
      { name: "Lightest", minWeightKg: 0, modifiers: [] },
      { name: "Heavy", minWeightKg: 27, modifiers: [{ attribute: "Movement.MaxSpeedMultiplier", op: "multiplyCompound", value: 0.8 }] },
    ]);
  });
});

describe("resolveSystemsEntity", () => {
  const known = new Set(["Vehicle.Air.Rotary.Havoc", "Vehicle.Air.Rotary.LittleBird", "Vehicle.Land.Wheeled.Humvee.Default", "Vehicle.Land.Wheeled.Humvee.MachineGun", "Vehicle.Land.Wheeled.Patriot.Kodiak", "Vehicle.Land.Wheeled.Ural"]);

  it("matches the variant id exactly when the game's entity is the same", () => {
    expect(resolveSystemsEntity("Vehicle.Variant.Land.Wheeled.Humvee.MachineGun", known)).toBe("Vehicle.Land.Wheeled.Humvee.MachineGun");
    expect(resolveSystemsEntity("Vehicle.Variant.Land.Wheeled.Humvee.Default", known)).toBe("Vehicle.Land.Wheeled.Humvee.Default");
  });

  it("drops trailing segments, so the variants of one platform share an entity, and ignores case", () => {
    expect(resolveSystemsEntity("Vehicle.Variant.Land.Wheeled.Ural.Attack", known)).toBe("Vehicle.Land.Wheeled.Ural");
    expect(resolveSystemsEntity("Vehicle.Variant.Air.Rotary.Havoc.Default", known)).toBe("Vehicle.Air.Rotary.Havoc");
    expect(resolveSystemsEntity("Vehicle.Variant.Air.Rotary.Littlebird.RocketPods", known)).toBe("Vehicle.Air.Rotary.LittleBird");
  });

  it("applies the declared override for the Kodiak, and returns undefined when nothing matches", () => {
    expect(resolveSystemsEntity("Vehicle.Variant.Land.Wheeled.Kodiak.Pickup", known)).toBe("Vehicle.Land.Wheeled.Patriot.Kodiak");
    expect(resolveSystemsEntity("Vehicle.Variant.Land.Tracked.Unknown.Default", known)).toBeUndefined();
  });

  it("does not shorten past the vehicle class", () => {
    expect(resolveSystemsEntity("Vehicle.Variant.Land.Wheeled.Nothing", new Set(["Vehicle.Land"]))).toBeUndefined();
  });
});

describe("parseVehicleSystems", () => {
  it("reads the damage entity, health, fuel distance and wreck explosion (in meters)", () => {
    const parsed = parseVehicleSystems({
      Type: "WDVehicleGameplayComponentsDataAsset",
      Properties: {
        DamageEntitySettings: { VehicleDamageTag: { TagName: "Meta.Damage.Vehicle.Land.Wheeled.Humvee.Default" }, DestroyedExplosionDamageValues: { ExplosiveRadius: 1000, EffectiveExplosiveRadius: 500, ExplosiveDamageFallOff: 0.6 } },
        HealthSettings: { InitialVehicleHealth: 500, CriticalStateThreshold: 50, BleedOutTimer: 15 },
        FuelSettings: { MaxFuel: 65, KML: 0.3 },
      } as never,
    });
    expect(parsed).toEqual({
      entity: "Vehicle.Land.Wheeled.Humvee.Default",
      details: { health: { initial: 500, criticalThreshold: 50, bleedOutTime: 15 }, kmPerLiter: 0.3, destroyedExplosion: { radius: 10, effectiveRadius: 5, falloff: 0.6 } },
    });
  });

  it("leaves out what the asset does not define, and returns null without a damage entity", () => {
    const parsed = parseVehicleSystems({ Type: "WDVehicleGameplayComponentsDataAsset", Properties: { DamageEntitySettings: { VehicleDamageTag: { TagName: "Meta.Damage.Vehicle.Stationary.Mortar" } }, HealthSettings: { InitialVehicleHealth: 0 } } as never });
    expect(parsed?.details).toEqual({});
    expect(parseVehicleSystems({ Type: "WDVehicleGameplayComponentsDataAsset", Properties: {} })).toBeNull();
  });
});

describe("parseVehiclePhysics", () => {
  const ref = (path: string) => ({ ObjectPath: path });
  const curve = (...keys: [number, number][]): RawExport[] => [{ Type: "CurveFloat", Properties: { FloatCurve: { Keys: keys.map(([Time, Value]) => ({ Time, Value })) } } }];
  const packages: Record<string, RawExport[]> = {
    "/V/Chars": [{ Type: "MWheeledVehicleCharacteristicsDataAsset", Properties: { Mass: 2750 } }],
    "/V/Drive": [
      {
        Type: "MWheeledVehicleEngineTransmissionDataAsset",
        Properties: {
          EngineData: { TorqueCurve: ref("/V/Torque.0"), IdleRPM: 700, LimitRpm: 4000, FrictionTorque: 75, EngineInertia: 1.3 },
          TransmissionData: { ChangeTime: 200, GearRatios: [3.6, 2.4, 3.6], FinalGearRatio: 6.54 },
        },
      },
    ],
    "/V/Torque": curve([2000, 1350], [800, 850]),
    "/V/Body": [{ Type: "BHRotaryVehicleBodyDataAsset", Properties: { bEnableMassOverride: true, MassOverride: 7500 } }],
    "/V/UnusedBody": [{ Type: "BHRotaryVehicleBodyDataAsset", Properties: { MassOverride: 99 } }],
    "/V/Tracks": [{ Type: "MTrackedVehicleEngineData", Properties: { TorqueCurve: { ExternalCurve: ref("/V/Torque.0") }, DifferentialRatio: 6, GearRatios: [1.8, 0], EngineExtraPowerRatio: 7.5, TrackMass: 700 } }],
  };
  const index = { loadExport: (path: string | undefined | null, type: string) => packages[(path ?? "").replace(/\.\d+$/, "")]?.find((e) => e.Type === type) };
  const config = (properties: Record<string, unknown>): RawExport => ({ Type: "Config", Properties: properties as never });

  it("reads a wheeled vehicle's mass, engine and gearbox, with the curve sorted by rpm", () => {
    const physics = parseVehiclePhysics(config({ CharacteristicsDataAsset: ref("/V/Chars.0"), EngineTransmissionDataAsset: ref("/V/Drive.0") }), index);
    expect(physics).toEqual({
      mass: 2750,
      engine: { torqueCurve: [{ rpm: 800, torque: 850 }, { rpm: 2000, torque: 1350 }], frictionTorque: 75, idleRpm: 700, limitRpm: 4000, inertia: 1.3 },
      transmission: { gearRatios: [3.6, 2.4, 3.6], finalGearRatio: 6.54, changeTime: 200 },
    });
  });

  it("reads a helicopter's mass only when the override is enabled", () => {
    expect(parseVehiclePhysics(config({ RotaryVehicleBodyDataAsset: ref("/V/Body.0") }), index)).toEqual({ mass: 7500 });
    expect(parseVehiclePhysics(config({ RotaryVehicleBodyDataAsset: ref("/V/UnusedBody.0") }), index)).toEqual({});
  });

  it("reads a tracked vehicle's engine through an external curve, and its track masses", () => {
    expect(parseVehiclePhysics(config({ TrackedVehicleEngineData: ref("/V/Tracks.0") }), index)).toEqual({
      engine: { torqueCurve: [{ rpm: 800, torque: 850 }, { rpm: 2000, torque: 1350 }], extraPowerRatio: 7.5 },
      transmission: { gearRatios: [1.8, 0], finalGearRatio: 6 },
      tracks: { trackMass: 700 },
    });
  });

  it("returns nothing for a config that names no physics", () => {
    expect(parseVehiclePhysics(config({}), index)).toEqual({});
  });
});
