import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function put(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

const text = (value: string) => ({ LocalizedString: value, SourceString: value });
const ref = (objectPath: string) => ({ ObjectName: "X", ObjectPath: objectPath });

/**
 * A tiny synthetic game cache with one weapon, its magazine, its ammo and one vehicle, enough for every gameplay
 * dataset. Numbers are made up so they cannot be mistaken for game values.
 */
export function writeGameplayFixture(raw: string): void {
  const items = join(raw, "items/Wardogs");
  const gameplay = join(raw, "gameplay/Wardogs");

  put(join(items, "Plugins/GameFeatures/Guns/GUN_01/Content/Data/ID_Gun.json"), [
    { Type: "BHInventoryItemDefinition", Properties: { ItemId: { TagName: "Id.Item.Gun" }, DisplayName: text("Test Gun") } },
    { Type: "WDItemExtensionData_RangedWeapon", Properties: { WeaponStats: ref("/GUN_01/Data/DA_Gun_Stats.0") } },
    {
      Type: "BHInventoryFragment_SubSlotSupport",
      Properties: {
        Containers: [
          {
            ContainerIdentifier: { TagName: "Item.Attachment.Magazine" },
            Filter: { SupportFilter: "EBHSupportFilterMethod::AllowList", AllowedSubSlotItems: ["Id.Item.GunMag"], AllowedSubSlotContext: [], BlockedSubSlotItems: [], BlockedSubSlotContext: [] },
            bIsHiddenContainer: false,
            DefaultItems: ["Id.Item.GunMag"],
          },
          {
            ContainerIdentifier: { TagName: "Item.Attachment.Chamber" },
            Filter: { SupportFilter: "EBHSupportFilterMethod::AllowList", AllowedSubSlotItems: [], AllowedSubSlotContext: ["Item.Caliber.100mm"], BlockedSubSlotItems: [], BlockedSubSlotContext: [] },
            bIsHiddenContainer: true,
            DefaultItems: [],
          },
        ],
      },
    },
  ]);
  put(join(items, "Content/Items/ID_GunMag.json"), [
    { Type: "BHInventoryItemDefinition", Properties: { ItemId: { TagName: "Id.Item.GunMag" }, ItemContext: ["Item.Attachment.Magazine"], DisplayName: text("Test Mag") } },
    {
      Type: "WDInventoryFragment_Attachment",
      Properties: { AttachmentData: { AttachmentType: { TagName: "Item.Attachment.Magazine" }, AppliedEffects: [ref("/Game/Items/GE_Mag.0")], AppliedCharacterEffects: [] } },
    },
    {
      Type: "BHInventoryFragment_SubSlotSupport",
      Properties: {
        Containers: [
          {
            ContainerIdentifier: { TagName: "Item.Ammo" },
            Filter: { SupportFilter: "EBHSupportFilterMethod::AllowList", AllowedSubSlotItems: [], AllowedSubSlotContext: ["Item.Caliber.100mm"], BlockedSubSlotItems: [], BlockedSubSlotContext: [] },
            MaxSlotAmountStackSize: 17,
            bIsHiddenContainer: true,
            DefaultItems: [],
          },
        ],
      },
    },
  ]);
  put(join(items, "Content/Items/ID_100mm.json"), [
    { Type: "BHInventoryItemDefinition", Properties: { ItemId: { TagName: "Id.Item.100mm" }, DisplayName: text("100mm") } },
    { Type: "WDInventoryFragment_Projectile", Properties: { ProjectileData: ref("/Game/Ammo/DA_100mm_ProjectileData.0") } },
  ]);
  put(join(items, "Plugins/GameFeatures/Vehicles/VEH_01/Content/DataTables/DT_VehicleMarket_VEH_01.json"), [
    {
      Type: "DataTable",
      Rows: {
        "Vehicle.Variant.Test": {
          VendorItemVariations: [{ VariationTag: { TagName: "Vehicle.Variant.Test" }, Price: 100, Amount: 1, VehicleStatsDataAsset: ref("/VEH_01/Data/DA_Veh_Stats.0") }],
        },
      },
    },
  ]);

  put(join(gameplay, "Plugins/GameFeatures/Guns/GUN_01/Content/Data/DA_Gun_Stats.json"), [
    {
      Type: "WDWeaponStatsData",
      Properties: {
        WeaponId: { TagName: "Id.Item.Gun" },
        WeaponStats: {
          WeaponAccuracy: { AccuracyValue: 0.5 },
          RoundsPerMinute: 600,
          SupportedFireModes: ["EWDFireMode::Automatic", "EWDFireMode::SemiAutomatic"],
          SupportedCaliber: ["Item.Caliber.100mm"],
          InitialBulletSpeed: 90000,
          EffectiveRange: 400,
          bUseDistanceDamageFalloffCurve: true,
          DistanceDamageFalloffCurve: { EditorCurveData: { Keys: [{ Time: 0, Value: 1 }, { Time: 40000, Value: 1 }, { Time: 100000, Value: 0.5 }] } },
          RecoilPattern: [{ X: 0.1, Y: 0.5 }, { X: -0.1, Y: 0.75 }],
          RecoilPatternResetTime: 0.5,
          PostPatternRandomPitchRecoil: { X: 0.2, Y: 0.4 },
          MaxZeroingRange: 800,
          MeleeDamage: 30,
        },
      },
    },
  ]);
  put(join(gameplay, "Content/Ammo/DA_100mm_ProjectileData.json"), [
    {
      Type: "WDProjectileData",
      Properties: {
        ProjectileId: { TagName: "Item.Caliber.100mm" },
        ProjectileStats: {
          DamageEntityData: { Tag: { TagName: "Meta.Damage.Bullet.100mm" }, Context: ["Meta.Damage.Arms.Medium"] },
          DamageValues: { BaseDamage: 33, ExplosiveRadius: 500 },
          ProjectileDimensions: { Length: 2, Diameter: 1, Mass: 0.01, DragModel: { Value: 0.3, Curve: { CurveTable: null, RowName: "G1" } } },
          TypicalSpeed: 30000,
          PenetrationExitSpeedMultiplier: 0.2,
          SuppressionData: { BaseSuppression: 0.5 },
        },
      },
    },
  ]);
  put(join(gameplay, "Content/Items/GE_Mag.json"), [
    { Type: "BlueprintGeneratedClass", Properties: {} },
    {
      Type: "GE_Mag_C",
      Properties: {
        Modifiers: [
          { Attribute: { TagName: "Attribute.Gameplay.Weapon.AimTime" }, Operation: "EBHAttributeModOp::MultiplyCompound", Modifier: { Scalar: { Value: 1.1, Curve: { CurveTable: null, RowName: "None" } }, CurveIndexing: "EBHAttributeScalarIndex::Fixed" } },
          { Attribute: { TagName: "Attribute.Gameplay.Weapon.SpreadMultiplier" }, Operation: "EBHAttributeModOp::MultiplyCompound", Modifier: { Scalar: { Value: 1, Curve: { CurveTable: null, RowName: "None" } }, CurveIndexing: "EBHAttributeScalarIndex::Fixed" } },
        ],
      },
    },
  ]);
  put(join(gameplay, "Plugins/GameFeatures/Vehicles/VEH_01/Content/Data/DA_Veh_Stats.json"), [
    {
      Type: "WDVehicleStatsDataAsset",
      Properties: {
        MaxSpeed: 120,
        MaxFuel: 60,
        FuelEconomy: 3.5,
        MaxSeats: 4,
        VehicleWeaponryNames: [text("Test Cannon")],
        VehicleCounterMeasuresNames: [],
      },
    },
  ]);
}

/** The four movement assets (`MOVEMENT_ASSETS`) with a stand stance and one fall damage point, enough for the movement dataset. */
export function writeMovementFixture(raw: string): void {
  const gameplay = join(raw, "gameplay/Wardogs/Content/MoverTesting/Settings");
  put(join(gameplay, "DA_GroundMovement.json"), [
    { Type: "BHFloatModifier_Operation", Name: "Op_Stand", Properties: { Operation: "EBHFloatValueOperationType::Multiply", Magnitude: 0.8 } },
    {
      Type: "BHGroundMovementData",
      Properties: {
        MinSpeed: 80,
        JumpVelocity: 320,
        StanceSettings: [{ Key: "EBHPlayerStance::Stand", Value: { CapsuleHalfHeight: 96, CapsuleRadius: 34, EyeHeight: 168, StanceStaminaCost: 20, MaxSpeedModifier: { ObjectName: "BHFloatModifier_Operation'DA_GroundMovement:Op_Stand'" } } }],
        StanceTransitionSettings: [],
        SlowWalkSpeedSettings: [],
      },
    },
  ]);
  put(join(gameplay, "DA_BodyDragging_GroundMovement.json"), [{ Type: "BHGroundMovementData", Properties: { BackMaxSpeedScale: 0.7 } }]);
  put(join(gameplay, "DA_FallingMovement.json"), [{ Type: "WDFallingData", Properties: { MaxSpeed: 300, DamageLookup: { ObjectPath: "/Game/MoverTesting/CRV_Fall.0" } } }]);
  put(join(gameplay, "DA_LadderClimbingMovement.json"), [{ Type: "BHLadderClimbingData", Properties: { ClimbUpMaxSpeed: 160 } }]);
  put(join(gameplay, "B_CommonPawnMovementSettings.json"), [{ Type: "B_CommonPawnMovementSettings_C", Name: "Default__B_CommonPawnMovementSettings_C", Properties: { StaminaRegenPerSecond: 20, StaminaStartRegenDelay: 0, StaminaDepletedRegenDelay: 2, MaxWalkableSlopeAngle: 55 } }]);
  put(join(gameplay, "DA_SwimmingMovement.json"), [{ Type: "BHMoverSwimmingDataAsset", Properties: { WaterAcceleration: 4000, InputDeceleration: 500 } }]);
  put(join(gameplay, "DA_VaultingMovement.json"), [{ Type: "BHVaultingData", Properties: { VaultDistance: 74, BaseTraversalSpeed: 600 } }]);
  put(join(gameplay, "DA_MantlingMovement.json"), [{ Type: "BHMantlingData", Properties: { MaxHeightAboveLedgeToScaleOver: 55, ForwardOnlyHeight: 127.5, MaxAllowedWallAngle: 60, BaseScaleOverSpeed: 200 } }]);
  put(join(gameplay, "DA_ClimbingMovement.json"), [{ Type: "BHClimbingData", Properties: { MaxLedgeLookAngle: 60, BaseTraversalSpeed: 145, BaseScaleOverSpeed: 145 } }]);
  put(join(gameplay, "DA_ParachuteMovement.json"), [{ Type: "WDParachuteData", Properties: { MinFallHeightBeforeAbleToParachute: 100, GliderAcceleration: 1250, MinPitch: -10, MaxPitch: 15, MaxRoll: 20 } }]);
  put(join(raw, "gameplay/Wardogs/Content/MoverTesting/CRV_Fall.json"), [{ Type: "CurveFloat", Properties: { FloatCurve: { Keys: [{ Time: 670, Value: 0 }] } } }]);
}

/** The meta tables (currencies, gold market, passive missions, achievements, season) with one row each. */
export function writeMetaFixture(raw: string): void {
  const meta = join(raw, "items/Wardogs/Content/Meta");
  const table = (struct: string, rows: Record<string, unknown>) => [{ Type: "DataTable", Properties: { RowStruct: { ObjectName: `Class'${struct}'` } }, Rows: rows }];
  const text = (v: string) => ({ LocalizedString: v });
  put(join(meta, "CurrencyDefinitions/DT_CurrenciesDefinitions.json"), table("WDCurrencyDefinition", { "Attribute.Meta.Currency.Cash": { DisplayName: text("Cash"), InitialBalance: 10000 } }));
  put(join(meta, "Collection/DT_GoldMarket.json"), table("WDGoldMarketItemTableRow", {
    "Meta.Cosmetic.DigitalWood.M4": { GoldBarCost: 10, Category: { TagName: "Meta.Cosmetic.DigitalWood" }, EntityID: { TagName: "Id.Item.M4" }, GridIndex: 0, TileSize: "EGameDataUITileSize::SMALL_SQUARE", ExpirationType: "EGameDataExpirationType::NO_EXPIRATION", ExpirationTime: { Ticks: 0 } },
  }));
  put(join(meta, "Missions/DT_PassiveMissionChallenges.json"), table("WDChallengeDefinition", {
    "Challenges.Challenge.Mission.Passive.TimePlayed.1": {
      DisplayName: text("Time Played"),
      Rewards: [{ RewardTag: { TagName: "Attribute.Meta.Currency.Intel" }, Quantity: 100 }],
      Objectives: [{ Key: { TagName: "Challenges.Objective.TimePlayed" }, Value: 1800 }],
    },
  }));
  put(join(meta, "Missions/DT_PassiveMissions.json"), table("WDMissionDefinition", { "Mission.Passive.TimePlayed": { DifficultyWeight: 1, Challenges: [{ TagName: "Challenges.Challenge.Mission.Passive.TimePlayed.1" }] } }));
  put(join(meta, "Challenges/DT_Challenges_SessionEvents_Shared.json"), table("WDChallengeDefinition", { "Achievement.Match.CleanSweep": { DisplayName: text("Clean Sweep") } }));
  put(join(meta, "Achievements/DT_Achievements.json"), table("WDAchievementDefinition", { "Achievement.Match.CleanSweep": { SteamAchievementID: "ACH_MATCH_CLEAN_SWEEP", DisplayName: text("Clean Sweep") } }));
  put(join(meta, "DT_SeasonDefinitions.json"), table("WDMetaSeasonDefinitionTableRow", { "Meta.Season.Definitions": { CurrentSeasonNumber: 1, SeasonDefinitions: [] } }));
}
