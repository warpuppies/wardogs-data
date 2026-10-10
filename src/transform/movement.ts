import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GeneratedFile } from "../generated.js";
import { MovementFile, type Stance } from "../schema.gameplay.js";
import type { RawExport } from "./items.js";
import { PackageIndex } from "./packages.js";

type Props = Record<string, any>; // decoded game properties: shapes are checked field by field below

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const CM = 100;
const meters = (v: unknown): number | undefined => (num(v) === undefined ? undefined : Math.round(((v as number) / CM) * 1e6) / 1e6);
const compact = <T extends object>(obj: T): T => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
const enumName = (v: unknown): string => String(v ?? "").replace(/^E[A-Za-z]+::/, "");

/**
 * The movement assets, declared by game path. The game keeps the player's movement tuning in these data assets; a
 * missing one fails the build rather than publishing a file with holes.
 */
export const MOVEMENT_ASSETS = {
  ground: "/Game/MoverTesting/Settings/DA_GroundMovement",
  bodyDragging: "/Game/MoverTesting/Settings/DA_BodyDragging_GroundMovement",
  common: "/Game/MoverTesting/Settings/B_CommonPawnMovementSettings",
  swimming: "/Game/MoverTesting/Settings/DA_SwimmingMovement",
  vaulting: "/Game/MoverTesting/Settings/DA_VaultingMovement",
  mantling: "/Game/MoverTesting/Settings/DA_MantlingMovement",
  climbing: "/Game/MoverTesting/Settings/DA_ClimbingMovement",
  parachute: "/Game/MoverTesting/Settings/DA_ParachuteMovement",
  falling: "/Game/MoverTesting/Settings/DA_FallingMovement",
  ladder: "/Game/MoverTesting/Settings/DA_LadderClimbingMovement",
} as const;

const main = (exports: RawExport[], type: string): Props => ((exports.find((e) => e.Type === type)?.Properties ?? {}) as Props);

/**
 * A float modifier an asset refers to by object name (`BHFloatModifier_Operation'Asset:Name_4'`), as a multiplier. Only
 * an explicit `Multiply` operation counts: modifiers with no stated operation use a game default that is not in the data.
 */
function multiplierOf(exports: RawExport[], ref: unknown): number | undefined {
  const raw = (ref as { ObjectName?: unknown } | undefined)?.ObjectName;
  const name = typeof raw === "string" ? /:([^:']+)'$/.exec(raw)?.[1] : undefined;
  if (!name) return undefined;
  const props = (exports.find((e) => e.Name === name)?.Properties ?? {}) as Props;
  return props.Operation === "EBHFloatValueOperationType::Multiply" ? num(props.Magnitude) : undefined;
}

/** Stances (sizes, stamina cost, speed multiplier) from a ground movement asset (`BHGroundMovementData`). */
export function parseStances(exports: RawExport[]): Stance[] {
  const order = ["Stand", "Crouch", "Prone"];
  const out: Stance[] = [];
  for (const entry of ((main(exports, "BHGroundMovementData").StanceSettings ?? []) as Props[])) {
    const name = enumName(entry.Key).replace("BHPlayerStance::", "");
    const v = (entry.Value ?? {}) as Props;
    const half = meters(v.CapsuleHalfHeight);
    const radius = meters(v.CapsuleRadius);
    const eye = meters(v.EyeHeight);
    if (!name || half === undefined || radius === undefined || eye === undefined) continue;
    out.push(compact({ name, capsuleHalfHeight: half, capsuleRadius: radius, eyeHeight: eye, staminaCost: num(v.StanceStaminaCost) ?? 0, maxSpeedMultiplier: multiplierOf(exports, v.MaxSpeedModifier) }) as Stance);
  }
  return out.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
}

export function parseGround(exports: RawExport[]): MovementFile["ground"] {
  const p = main(exports, "BHGroundMovementData");
  const slowWalk: Record<string, number> = {};
  for (const e of (p.SlowWalkSettings ?? p.SlowWalkSpeedSettings ?? []) as Props[]) {
    const value = num(e.Value);
    if (value !== undefined) slowWalk[enumName(e.Key).replace("BHSlowWalkSettings::", "")] = value;
  }
  return compact({
    minSpeed: meters(p.MinSpeed),
    backMaxSpeedScale: num(p.BackMaxSpeedScale),
    strafeMaxSpeedScale: num(p.StrafeMaxSpeedScale),
    forwardStrafeScale: num(p.ForwardStrafeScale),
    forwardStrafeScaleSprinting: num(p.ForwardStrafeScaleSprinting),
    slowWalk,
    leanTime: num(p.LeanTime),
    unleanTime: num(p.UnleanTime),
    blockSprintTime: num(p.BlockSprintTime),
    blockTacticalSprintTime: num(p.BlockTacSprintTime),
    minStartTacticalSprint: num(p.MinStartTacSprintPercentage),
  }) as MovementFile["ground"];
}

export function parseTransitions(exports: RawExport[]): MovementFile["stanceTransitions"] {
  return ((main(exports, "BHGroundMovementData").StanceTransitionSettings ?? []) as Props[]).flatMap((t) => {
    const seconds = num(t.Value?.TransitionTime);
    const from = enumName(t.Key?.FromStance).replace("BHPlayerStance::", "");
    const to = enumName(t.Key?.ToStance).replace("BHPlayerStance::", "");
    return seconds === undefined || !from || !to ? [] : [{ from, to, seconds }];
  });
}

export function parseJump(exports: RawExport[]): MovementFile["jump"] {
  const p = main(exports, "BHGroundMovementData");
  return compact({ velocity: meters(p.JumpVelocity), maxStamina: num(p.MaxJumpStamina), staminaCost: num(p.JumpStaminaCost), staminaRegenPerSecond: num(p.JumpStaminaRegenPerSecond), cooldown: num(p.JumpCooldown) }) as MovementFile["jump"];
}

/** Falling (`WDFallingData`) and its landing damage curve, which the asset points at. */
export function parseFalling(exports: RawExport[], curve: RawExport[] | undefined): MovementFile["falling"] {
  const p = main(exports, "WDFallingData");
  const keys = ((curve?.find((e) => e.Type === "CurveFloat")?.Properties as Props | undefined)?.FloatCurve?.Keys ?? []) as Props[];
  const landingDamage = keys.flatMap((k) => (num(k.Time) !== undefined && num(k.Value) !== undefined ? [{ speed: meters(k.Time)!, damage: k.Value as number }] : []));
  return { ...compact({ maxSpeed: meters(p.MaxSpeed), airControl: num(p.AirControlPercentage), terminalSpeed: meters(p.VerticalTerminalSpeed) }), landingDamage } as MovementFile["falling"];
}

export function parseLadder(exports: RawExport[]): MovementFile["ladder"] {
  const p = main(exports, "BHLadderClimbingData");
  return compact({ climbUpMaxSpeed: meters(p.ClimbUpMaxSpeed), climbDownMaxSpeed: meters(p.ClimbDownMaxSpeed), slideDownSpeed: meters(p.SlideDownSpeed) }) as MovementFile["ladder"];
}

export function parseBodyDragging(exports: RawExport[]): MovementFile["bodyDragging"] {
  const p = main(exports, "BHGroundMovementData");
  return compact({ backMaxSpeedScale: num(p.BackMaxSpeedScale), strafeMaxSpeedScale: num(p.StrafeMaxSpeedScale), forwardStrafeScale: num(p.ForwardStrafeScale), backwardStrafeScale: num(p.BackwardStrafeScale) }) as MovementFile["bodyDragging"];
}

/** The properties of a blueprint's default object, which is where a settings blueprint keeps its values. */
const defaults = (exports: RawExport[]): Props => ((exports.find((e) => String(e.Name ?? "").startsWith("Default__"))?.Properties ?? {}) as Props);

/** Stamina regeneration: the common pawn settings blueprint and the ground movement asset's stance stamina. */
export function parseStamina(common: RawExport[], ground: RawExport[]): MovementFile["stamina"] {
  const c = defaults(common);
  const g = main(ground, "BHGroundMovementData");
  return compact({
    regenPerSecond: num(c.StaminaRegenPerSecond),
    regenDelay: num(c.StaminaStartRegenDelay),
    depletedRegenDelay: num(c.StaminaDepletedRegenDelay),
    stanceRegenPerSecond: num(g.StanceStaminaRegenPerSecond),
    stanceRegenDelay: num(g.StanceStaminaRegenDelay),
    stanceCooldown: num(g.StanceCooldown),
  }) as MovementFile["stamina"];
}

export function parseSwimming(exports: RawExport[]): MovementFile["swimming"] {
  const p = main(exports, "BHMoverSwimmingDataAsset");
  return compact({ waterAcceleration: meters(p.WaterAcceleration), inputDeceleration: meters(p.InputDeceleration) }) as MovementFile["swimming"];
}

export function parseVaulting(exports: RawExport[]): MovementFile["vaulting"] {
  const p = main(exports, "BHVaultingData");
  return compact({ vaultDistance: meters(p.VaultDistance), baseTraversalSpeed: meters(p.BaseTraversalSpeed) }) as MovementFile["vaulting"];
}

export function parseMantling(exports: RawExport[]): MovementFile["mantling"] {
  const p = main(exports, "BHMantlingData");
  return compact({
    maxHeightAboveLedge: meters(p.MaxHeightAboveLedgeToScaleOver),
    forwardOnlyHeight: meters(p.ForwardOnlyHeight),
    maxTargetFloorHeight: meters(p.MaxTargetFloorHeight),
    maxWallWidth: meters(p.MaxWallWidth),
    maxWallAngle: num(p.MaxAllowedWallAngle),
    baseScaleOverSpeed: meters(p.BaseScaleOverSpeed),
  }) as MovementFile["mantling"];
}

export function parseClimbing(exports: RawExport[]): MovementFile["climbing"] {
  const p = main(exports, "BHClimbingData");
  return compact({ maxLedgeLookAngle: num(p.MaxLedgeLookAngle), baseTraversalSpeed: meters(p.BaseTraversalSpeed), baseScaleOverSpeed: meters(p.BaseScaleOverSpeed) }) as MovementFile["climbing"];
}

export function parseParachute(exports: RawExport[]): MovementFile["parachute"] {
  const p = main(exports, "WDParachuteData");
  return compact({
    minFallHeight: meters(p.MinFallHeightBeforeAbleToParachute),
    gliderAcceleration: meters(p.GliderAcceleration),
    pullUpDragAcceleration: meters(p.PullUpDragAcceleration),
    pullUpStaminaPerSecond: num(p.PullUpStaminaUsagePerSecond),
    pullUpStaminaRegenPerSecond: num(p.PullUpStaminaRegenPerSecond),
    minPitch: num(p.MinPitch),
    maxPitch: num(p.MaxPitch),
    maxRoll: num(p.MaxRoll),
  }) as MovementFile["parachute"];
}

export interface MovementBuild {
  files: GeneratedFile[];
  notes: string[];
}

/** Builds `data/movement.json` from the gameplay cache, without touching the disk. */
export function buildMovementData(rawDir: string, gameBuild: string): MovementBuild {
  const gameplayDir = join(rawDir, "gameplay");
  if (!existsSync(gameplayDir)) throw new Error("The gameplay cache is empty. Run `pnpm extract gameplay` first.");
  const index = new PackageIndex([gameplayDir]);
  const need = (path: string): RawExport[] => {
    const exports = index.load(path);
    if (!exports) throw new Error(`The movement asset ${path} is not in the gameplay cache. Run \`pnpm extract gameplay\` first.`);
    return exports;
  };
  const ground = need(MOVEMENT_ASSETS.ground);
  const common = need(MOVEMENT_ASSETS.common);
  const falling = need(MOVEMENT_ASSETS.falling);
  const fallDamagePath = ((main(falling, "WDFallingData").DamageLookup ?? {}) as { ObjectPath?: string }).ObjectPath;
  const file = MovementFile.parse({
    schemaVersion: 1,
    gameBuild,
    units: "meters",
    stances: parseStances(ground),
    stanceTransitions: parseTransitions(ground),
    ground: parseGround(ground),
    jump: parseJump(ground),
    falling: parseFalling(falling, index.load(fallDamagePath)),
    ladder: parseLadder(need(MOVEMENT_ASSETS.ladder)),
    bodyDragging: parseBodyDragging(need(MOVEMENT_ASSETS.bodyDragging)),
    stamina: parseStamina(common, ground),
    slopes: compact({ maxWalkableAngle: num(defaults(common).MaxWalkableSlopeAngle) }),
    friction: num(main(ground, "BHGroundMovementData").Friction),
    swimming: parseSwimming(need(MOVEMENT_ASSETS.swimming)),
    vaulting: parseVaulting(need(MOVEMENT_ASSETS.vaulting)),
    mantling: parseMantling(need(MOVEMENT_ASSETS.mantling)),
    climbing: parseClimbing(need(MOVEMENT_ASSETS.climbing)),
    parachute: parseParachute(need(MOVEMENT_ASSETS.parachute)),
  });
  return {
    files: [{ path: "data/movement.json", content: JSON.stringify(file, null, 2) + "\n" }],
    notes: [`movement: ${file.stances.length} stances, ${file.falling.landingDamage.length} fall damage points`],
  };
}
