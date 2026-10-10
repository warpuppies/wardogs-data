import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDamageData, parseAmmoTypes, parseDamageRules, parseHitLocationMultipliers, parseVehicleSeats } from "../src/transform/damage.js";
import type { RawExport } from "../src/transform/items.js";

const table = (struct: string, rows: Record<string, unknown>): RawExport[] => [
  { Type: "DataTable", Properties: { RowStruct: { ObjectName: `Class'${struct}'` } } as never, Rows: rows as never },
];

const entry = (over: Record<string, unknown> = {}, om: Record<string, unknown> = {}) => ({
  InstigatorRequirements: [],
  TargetRequirements: [],
  SourceRequirements: [],
  AlignmentRequired: "EWDDamageAlignment::None",
  PossibleHitLocations: [],
  OutModification: { bUseCustomOperation: false, Operation: "EWDDamageModificationOperation::None", Amount: 0, CustomOperationClass: null, PriorityCategory: { TagName: "None" }, ...om },
  ...over,
});

describe("parseDamageRules", () => {
  it("drops padding entries and keeps real rules in order, with prefixes removed", () => {
    const rules = parseDamageRules(
      table("WDDamageableEntityTableRow", {
        "Meta.Damage.Infantry": {
          DamageModificationEntries: [
            entry(),
            entry(
              { SourceRequirements: ["Meta.Damage.Bullet", "Meta.Damage.AmmoModifier.HollowPoint"], TargetRequirements: ["Meta.Damage.Helmet"], PossibleHitLocations: ["Meta.Damage.HitLocation.Infantry"] },
              { Operation: "EWDDamageModificationOperation::Percentage_Ongoing", Amount: -70, PriorityCategory: { TagName: "Meta.Damage.Category.Tracer" } },
            ),
            entry({ AlignmentRequired: "EWDDamageAlignment::Friendly", SourceRequirements: ["Meta.Damage.Bullet"] }, { Operation: "EWDDamageModificationOperation::Percentage_Ongoing", Amount: -50, PriorityCategory: { TagName: "Meta.Damage.Category.Friendly" } }),
          ],
        },
      }),
    );
    expect(rules).toEqual([
      { entity: "Infantry", source: ["Bullet", "AmmoModifier.HollowPoint"], target: ["Helmet"], instigator: [], hitLocations: ["Infantry"], category: "Tracer", operation: "Percentage_Ongoing", amount: -70 },
      { entity: "Infantry", source: ["Bullet"], target: [], instigator: [], hitLocations: [], alignment: "Friendly", category: "Friendly", operation: "Percentage_Ongoing", amount: -50 },
    ]);
  });

  it("keeps a custom operation even when its amount is zero, and names the code", () => {
    const [rule] = parseDamageRules(
      table("WDDamageableEntityTableRow", {
        "Meta.Damage.Infantry": {
          DamageModificationEntries: [entry({ SourceRequirements: ["Meta.Damage.Bullet"] }, { bUseCustomOperation: true, CustomOperationClass: { ObjectName: "BlueprintGeneratedClass'B_BoneDamageModifiers_C'" } })],
        },
      }),
    );
    expect(rule).toMatchObject({ operation: "None", amount: 0, custom: "B_BoneDamageModifiers_C" });
  });

  it("reads tags written as struct objects as well as plain strings", () => {
    const [rule] = parseDamageRules(
      table("WDDamageableEntityTableRow", {
        "Meta.Damage.Armor": { DamageModificationEntries: [entry({ SourceRequirements: [{ TagName: "Meta.Damage.Bullet" }] }, { Operation: "EWDDamageModificationOperation::Percentage_Ongoing", Amount: -60 })] },
      }),
    );
    expect(rule?.source).toEqual(["Bullet"]);
  });

  it("ignores tables of other row structs", () => {
    expect(parseDamageRules(table("WDVendorData", { x: { DamageModificationEntries: [entry({}, { Operation: "EWDDamageModificationOperation::Percentage_Ongoing", Amount: 1 })] } }))).toEqual([]);
  });
});

describe("parseHitLocationMultipliers", () => {
  it("reads a multiplier per body part, keyed by weapon class", () => {
    const rows = parseHitLocationMultipliers(
      table("WDBoneDamageModifierData", {
        Universal: { HitLocations: [{ Key: { TagName: "Meta.Damage.HitLocation.Infantry.Head" }, Value: 1 }] },
        "Meta.Damage.Weapon.AR": { HitLocations: [{ Key: { TagName: "Meta.Damage.HitLocation.Infantry.Head" }, Value: 2.35 }, { Key: { TagName: "Meta.Damage.HitLocation.Infantry.Torso.Upper" }, Value: 1 }] },
      }),
    );
    expect(rows).toEqual([
      { weaponClass: "Universal", multipliers: { Head: 1 } },
      { weaponClass: "Weapon.AR", multipliers: { Head: 2.35, "Torso.Upper": 1 } },
    ]);
  });
});

describe("parseAmmoTypes", () => {
  it("finds the per-class list by its shape, whatever the scrambled field is called", () => {
    const rows = parseAmmoTypes(
      table("WDAmmoTypeEffectivenessData", {
        "Meta.Damage.AmmoModifier.ArmorPiercing": { Modifier: 0.3, _aaabzz_$1$: [{ Key: { TagName: "Meta.Damage.Arms.Small" }, Value: 0.7 }], Tag: { TagName: "x" } },
        "Meta.Damage.AmmoModifier.FMJ": { Modifier: 1, _aaabzz_$1$: [], Tag: { TagName: "y" } },
      }),
    );
    expect(rows).toEqual([
      { ammoType: "ArmorPiercing", modifier: 0.3, byArmsClass: { Small: 0.7 } },
      { ammoType: "FMJ", modifier: 1, byArmsClass: {} },
    ]);
  });
});

describe("parseVehicleSeats", () => {
  it("reads the reduction per arms class for each vehicle", () => {
    const rows = parseVehicleSeats(
      table("WDVehicleSeatDamageReductionData", {
        "Vehicle.Variant.Test": {
          _aaabzz_$1$: [
            { DamageSources: ["Meta.Damage.Arms.Small", "Meta.Damage.Arms.Medium"], VehicleSeats: [{ Key: { TagName: "State.Player.Vehicle.SeatDamageReduction" }, Value: -90 }] },
            { DamageSources: ["Meta.Damage.Arms.High"], VehicleSeats: [{ Key: { TagName: "State.Player.Vehicle.SeatDamageReduction" }, Value: -50 }] },
          ],
          Tag: { TagName: "Vehicle.Variant.Test" },
        },
      }),
    );
    expect(rows).toEqual([{ vehicle: "Vehicle.Variant.Test", rules: [{ damageSources: ["Small", "Medium"], reduction: -90 }, { damageSources: ["High"], reduction: -50 }] }]);
  });
});

describe("buildDamageData", () => {
  it("collects every damage table in the cache and counts them", () => {
    const raw = mkdtempSync(join(tmpdir(), "wardogs-damage-"));
    const put = (path: string, value: unknown) => {
      mkdirSync(dirname(join(raw, path)), { recursive: true });
      writeFileSync(join(raw, path), JSON.stringify(value));
    };
    put("items/Wardogs/Content/DT_GlobalDamage_Test.json", table("WDDamageableEntityTableRow", { "Meta.Damage.Test": { DamageModificationEntries: [entry({}, { Operation: "EWDDamageModificationOperation::Percentage_Ongoing", Amount: 10 })] } }));
    put("items/Wardogs/Content/DT_InfantryData_Bone.json", table("WDBoneDamageModifierData", { Universal: { HitLocations: [] } }));
    put("items/Wardogs/Content/DT_Other.json", table("WDDamageableEntityTableRow", { "Meta.Damage.Skipped": { DamageModificationEntries: [entry({}, { Operation: "EWDDamageModificationOperation::Percentage_Ongoing", Amount: 1 })] } }));
    const { files, notes } = buildDamageData(raw, "7");
    const data = JSON.parse(files[0]!.content);
    expect(files[0]!.path).toBe("data/damage.json");
    expect(data.rules.map((r: { entity: string }) => r.entity)).toEqual(["Test"]); // DT_Other is not a damage table
    expect(data.hitLocationMultipliers).toHaveLength(1);
    expect(notes[0]).toContain("1 rules for 1 entities");
  });
});
