import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { MovementFile } from "../src/schema.gameplay.js";
import type { RawExport } from "../src/transform/items.js";
import { buildMovementData, MOVEMENT_ASSETS, parseBodyDragging, parseClimbing, parseFalling, parseGround, parseJump, parseLadder, parseMantling, parseParachute, parseStamina, parseStances, parseSwimming, parseTransitions, parseVaulting } from "../src/transform/movement.js";

const modifier = (name: string, props: Record<string, unknown>): RawExport => ({ Type: "BHFloatModifier_Operation", Name: name, Properties: props as never });
const ref = (name: string) => ({ ObjectName: `BHFloatModifier_Operation'DA_GroundMovement:${name}'` });
const stance = (key: string, half: number, eye: number, cost: number, maxSpeed?: string) => ({
  Key: `EBHPlayerStance::${key}`,
  Value: { CapsuleHalfHeight: half, CapsuleRadius: 34, EyeHeight: eye, StanceStaminaCost: cost, MaxSpeedModifier: maxSpeed ? ref(maxSpeed) : null, AccelerationModifier: ref("Op_Accel") },
});

const ground = (): RawExport[] => [
  modifier("Op_Accel", { Magnitude: 7 }), // no stated operation: not a multiplier
  modifier("Op_Stand", { Operation: "EBHFloatValueOperationType::Multiply", Magnitude: 0.8 }),
  modifier("Op_Prone", { Operation: "EBHFloatValueOperationType::Multiply", Magnitude: 0.15 }),
  {
    Type: "BHGroundMovementData",
    Properties: {
      MinSpeed: 80,
      BackMaxSpeedScale: 0.7,
      StrafeMaxSpeedScale: 0.7,
      ForwardStrafeScale: 0.6,
      ForwardStrafeScaleSprinting: 0.35,
      JumpVelocity: 320,
      MaxJumpStamina: 150,
      JumpStaminaCost: 50,
      JumpStaminaRegenPerSecond: 50,
      JumpCooldown: 0.05,
      LeanTime: 0.55,
      UnleanTime: 0.35,
      BlockSprintTime: 0.8,
      BlockTacSprintTime: 0.6,
      MinStartTacSprintPercentage: 0.2,
      SlowWalkSpeedSettings: [{ Key: "EBHSlowWalkSettings::Slow", Value: 0.2 }, { Key: "EBHSlowWalkSettings::Fast", Value: 0.6 }],
      StanceSettings: [stance("Prone", 34, 36, 40, "Op_Prone"), stance("Stand", 96, 168, 20, "Op_Stand"), stance("Crouch", 68, 118, 30)],
      StanceTransitionSettings: [{ Key: { FromStance: "EBHPlayerStance::Stand", ToStance: "EBHPlayerStance::Crouch" }, Value: { TransitionTime: 0.3 } }, { Key: {}, Value: {} }],
    } as never,
  },
];

describe("parseStances", () => {
  it("converts sizes to meters, orders stand, crouch, prone, and reads only explicit multipliers", () => {
    expect(parseStances(ground())).toEqual([
      { name: "Stand", capsuleHalfHeight: 0.96, capsuleRadius: 0.34, eyeHeight: 1.68, staminaCost: 20, maxSpeedMultiplier: 0.8 },
      { name: "Crouch", capsuleHalfHeight: 0.68, capsuleRadius: 0.34, eyeHeight: 1.18, staminaCost: 30 }, // no multiplier stated
      { name: "Prone", capsuleHalfHeight: 0.34, capsuleRadius: 0.34, eyeHeight: 0.36, staminaCost: 40, maxSpeedMultiplier: 0.15 },
    ]);
  });
});

describe("parseGround, parseJump, parseTransitions", () => {
  it("reads speeds in meters, scales as stored, and the slow-walk table by name", () => {
    expect(parseGround(ground())).toEqual({
      minSpeed: 0.8,
      backMaxSpeedScale: 0.7,
      strafeMaxSpeedScale: 0.7,
      forwardStrafeScale: 0.6,
      forwardStrafeScaleSprinting: 0.35,
      slowWalk: { Slow: 0.2, Fast: 0.6 },
      leanTime: 0.55,
      unleanTime: 0.35,
      blockSprintTime: 0.8,
      blockTacticalSprintTime: 0.6,
      minStartTacticalSprint: 0.2,
    });
  });

  it("reads the jump and the stance transitions, skipping incomplete ones", () => {
    expect(parseJump(ground())).toEqual({ velocity: 3.2, maxStamina: 150, staminaCost: 50, staminaRegenPerSecond: 50, cooldown: 0.05 });
    expect(parseTransitions(ground())).toEqual([{ from: "Stand", to: "Crouch", seconds: 0.3 }]);
  });
});

describe("parseFalling", () => {
  const falling: RawExport[] = [{ Type: "WDFallingData", Properties: { MaxSpeed: 300, AirControlPercentage: 0.2, VerticalTerminalSpeed: 5300 } as never }];
  const curve: RawExport[] = [{ Type: "CurveFloat", Properties: { FloatCurve: { Keys: [{ Time: 670, Value: 0 }, { Time: 1080, Value: 200 }] } } as never }];

  it("converts speeds to meters per second and reads the landing damage curve", () => {
    expect(parseFalling(falling, curve)).toEqual({ maxSpeed: 3, airControl: 0.2, terminalSpeed: 53, landingDamage: [{ speed: 6.7, damage: 0 }, { speed: 10.8, damage: 200 }] });
  });

  it("has an empty curve when the curve asset is missing", () => {
    expect(parseFalling(falling, undefined).landingDamage).toEqual([]);
  });
});

describe("parseLadder and parseBodyDragging", () => {
  it("convert ladder speeds and keep the body dragging scales", () => {
    expect(parseLadder([{ Type: "BHLadderClimbingData", Properties: { ClimbUpMaxSpeed: 160, ClimbDownMaxSpeed: 160, SlideDownSpeed: 320 } as never }])).toEqual({ climbUpMaxSpeed: 1.6, climbDownMaxSpeed: 1.6, slideDownSpeed: 3.2 });
    expect(parseBodyDragging([{ Type: "BHGroundMovementData", Properties: { BackMaxSpeedScale: 0.7, BackwardStrafeScale: 0.35 } as never }])).toEqual({ backMaxSpeedScale: 0.7, backwardStrafeScale: 0.35 });
  });
});

describe("traversal, stamina and swimming", () => {
  const one = (type: string, properties: Record<string, unknown>, name = "Asset"): RawExport[] => [{ Type: type, Name: name, Properties: properties as never }];

  it("reads the stamina regeneration from the common settings blueprint's default object and the ground asset", () => {
    const common = one("B_Common_C", { StaminaRegenPerSecond: 20, StaminaDepletedRegenDelay: 2 }, "Default__B_Common_C");
    expect(parseStamina(common, one("BHGroundMovementData", { StanceStaminaRegenPerSecond: 50, StanceCooldown: 0.15 }))).toEqual({ regenPerSecond: 20, depletedRegenDelay: 2, stanceRegenPerSecond: 50, stanceCooldown: 0.15 });
    expect(parseStamina(one("B_Common_C", { StaminaRegenPerSecond: 99 }, "B_Common_C"), [])).toEqual({});
  });

  it("converts distances and speeds to meters and keeps angles in degrees", () => {
    expect(parseSwimming(one("BHMoverSwimmingDataAsset", { WaterAcceleration: 4000, InputDeceleration: 500 }))).toEqual({ waterAcceleration: 40, inputDeceleration: 5 });
    expect(parseVaulting(one("BHVaultingData", { VaultDistance: 74, BaseTraversalSpeed: 600 }))).toEqual({ vaultDistance: 0.74, baseTraversalSpeed: 6 });
    expect(parseMantling(one("BHMantlingData", { MaxHeightAboveLedgeToScaleOver: 55, ForwardOnlyHeight: 127.5, MaxAllowedWallAngle: 60, BaseScaleOverSpeed: 200 }))).toEqual({ maxHeightAboveLedge: 0.55, forwardOnlyHeight: 1.275, maxWallAngle: 60, baseScaleOverSpeed: 2 });
    expect(parseClimbing(one("BHClimbingData", { MaxLedgeLookAngle: 60, BaseTraversalSpeed: 145 }))).toEqual({ maxLedgeLookAngle: 60, baseTraversalSpeed: 1.45 });
    expect(parseParachute(one("WDParachuteData", { MinFallHeightBeforeAbleToParachute: 100, GliderAcceleration: 1250, MinPitch: -10, PullUpStaminaUsagePerSecond: 50 }))).toEqual({ minFallHeight: 1, gliderAcceleration: 12.5, minPitch: -10, pullUpStaminaPerSecond: 50 });
  });
});

describe("buildMovementData", () => {
  const put = (raw: string, path: string, value: unknown) => {
    mkdirSync(dirname(join(raw, path)), { recursive: true });
    writeFileSync(join(raw, path), JSON.stringify(value));
  };
  const fixture = () => {
    const raw = mkdtempSync(join(tmpdir(), "wardogs-move-"));
    const asset = (path: string) => `gameplay/Wardogs/Content${path.replace("/Game", "")}.json`;
    put(raw, asset(MOVEMENT_ASSETS.ground), ground());
    put(raw, asset(MOVEMENT_ASSETS.bodyDragging), [{ Type: "BHGroundMovementData", Properties: { BackMaxSpeedScale: 0.7 } }]);
    put(raw, asset(MOVEMENT_ASSETS.falling), [{ Type: "WDFallingData", Properties: { MaxSpeed: 300, DamageLookup: { ObjectPath: "/Game/Curves/CRV_Fall.0" } } }]);
    put(raw, asset(MOVEMENT_ASSETS.ladder), [{ Type: "BHLadderClimbingData", Properties: { ClimbUpMaxSpeed: 160 } }]);
    put(raw, asset(MOVEMENT_ASSETS.common), [{ Type: "B_Common_C", Name: "Default__B_Common_C", Properties: { StaminaRegenPerSecond: 20, MaxWalkableSlopeAngle: 55 } }]);
    put(raw, asset(MOVEMENT_ASSETS.swimming), [{ Type: "BHMoverSwimmingDataAsset", Properties: { WaterAcceleration: 4000 } }]);
    put(raw, asset(MOVEMENT_ASSETS.vaulting), [{ Type: "BHVaultingData", Properties: { VaultDistance: 74 } }]);
    put(raw, asset(MOVEMENT_ASSETS.mantling), [{ Type: "BHMantlingData", Properties: { MaxAllowedWallAngle: 60 } }]);
    put(raw, asset(MOVEMENT_ASSETS.climbing), [{ Type: "BHClimbingData", Properties: { MaxLedgeLookAngle: 60 } }]);
    put(raw, asset(MOVEMENT_ASSETS.parachute), [{ Type: "WDParachuteData", Properties: { MaxRoll: 20 } }]);
    put(raw, "gameplay/Wardogs/Content/Curves/CRV_Fall.json", [{ Type: "CurveFloat", Properties: { FloatCurve: { Keys: [{ Time: 670, Value: 0 }, { Time: 875, Value: 100 }] } } }]);
    return raw;
  };

  it("joins the assets, including the fall damage curve the falling asset points at", () => {
    const { files } = buildMovementData(fixture(), "5");
    const file = MovementFile.parse(JSON.parse(files[0]!.content));
    expect(file.stances.map((s) => s.name)).toEqual(["Stand", "Crouch", "Prone"]);
    expect(file.falling.landingDamage).toEqual([{ speed: 6.7, damage: 0 }, { speed: 8.75, damage: 100 }]);
    expect(file).toMatchObject({ stamina: { regenPerSecond: 20 }, slopes: { maxWalkableAngle: 55 }, swimming: { waterAcceleration: 40 }, vaulting: { vaultDistance: 0.74 }, mantling: { maxWallAngle: 60 }, climbing: { maxLedgeLookAngle: 60 }, parachute: { maxRoll: 20 } });
    expect(buildMovementData(fixture(), "5").files).toEqual(files);
  });

  it("fails clearly when the gameplay cache is empty, or one movement asset is missing", () => {
    expect(() => buildMovementData(mkdtempSync(join(tmpdir(), "wardogs-move-empty-")), "1")).toThrow(/gameplay cache is empty.*pnpm extract gameplay/);
    const raw = fixture();
    rmSync(join(raw, "gameplay/Wardogs/Content/MoverTesting/Settings/DA_LadderClimbingMovement.json"));
    expect(() => buildMovementData(raw, "1")).toThrow(/DA_LadderClimbingMovement is not in the gameplay cache/);
  });
});

describe("data/movement.json: canaries", () => {
  const m = MovementFile.parse(JSON.parse(readFileSync("data/movement.json", "utf8")));
  const stance = (name: string) => m.stances.find((s) => s.name === name)!;

  it("stand, crouch and prone: 1.92 m, 1.36 m and 0.68 m tall, with top speed x0.8, x0.5 and x0.15", () => {
    expect(m.stances.map((s) => s.name)).toEqual(["Stand", "Crouch", "Prone"]);
    expect(stance("Stand")).toMatchObject({ capsuleHalfHeight: 0.96, eyeHeight: 1.68, staminaCost: 20, maxSpeedMultiplier: 0.8 });
    expect(stance("Crouch")).toMatchObject({ capsuleHalfHeight: 0.68, eyeHeight: 1.18, maxSpeedMultiplier: 0.5 });
    expect(stance("Prone")).toMatchObject({ capsuleHalfHeight: 0.34, eyeHeight: 0.36, maxSpeedMultiplier: 0.15 });
    expect(m.stanceTransitions).toContainEqual({ from: "Stand", to: "Crouch", seconds: 0.3 });
    expect(m.stanceTransitions).toHaveLength(4);
  });

  it("jump and falling: a jump leaves the ground at 3.2 m/s; fall damage starts at 6.7 m/s and is 200 at 10.8 m/s", () => {
    expect(m.jump.velocity).toBe(3.2);
    expect(m.falling.landingDamage).toEqual([{ speed: 6.7, damage: 0 }, { speed: 8.75, damage: 100 }, { speed: 10.8, damage: 200 }]);
    expect(m.falling.terminalSpeed).toBe(53);
  });

  it("stamina, slopes and traversal: stamina regains 20 per second, slopes up to 55 degrees can be walked, a vault runs at 6 m/s and a climb at 1.45 m/s", () => {
    expect(m.stamina).toMatchObject({ regenPerSecond: 20, depletedRegenDelay: 2, stanceRegenPerSecond: 50 });
    expect(m.slopes.maxWalkableAngle).toBe(55);
    expect(m.vaulting).toEqual({ vaultDistance: 0.74, baseTraversalSpeed: 6 });
    expect(m.climbing.baseTraversalSpeed).toBe(1.45);
    expect(m.mantling).toMatchObject({ forwardOnlyHeight: 1.275, maxHeightAboveLedge: 0.55 });
    expect(m.swimming).toEqual({ waterAcceleration: 40, inputDeceleration: 5 });
    expect(m.parachute).toMatchObject({ minFallHeight: 1, gliderAcceleration: 12.5, maxPitch: 15 });
  });

  it("ladders and strafing: 1.6 m/s up and down, backward and sideways at 70%", () => {
    expect(m.ladder).toMatchObject({ climbUpMaxSpeed: 1.6, climbDownMaxSpeed: 1.6, slideDownSpeed: 3.2 });
    expect(m.ground).toMatchObject({ backMaxSpeedScale: 0.7, strafeMaxSpeedScale: 0.7, slowWalk: { Slow: 0.2, Moderate: 0.4, Fast: 0.6 } });
  });
});
