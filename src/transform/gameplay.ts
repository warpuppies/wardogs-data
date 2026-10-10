import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  AmmoFile,
  Armor,
  Attachment,
  AttachmentsFile,
  EquipmentFile,
  Modifier,
  Projectile,
  Vehicle,
  VehicleConfigsFile,
  VehiclesFile,
  Weapon,
  WeaponSlot,
  WeaponsFile,
  type WeightClass,
} from "../schema.gameplay.js";
import type { GeneratedFile } from "../generated.js";
import type { RawExport } from "./items.js";
import { buildItemsData, ICONS_DIR } from "./build.js";
import { PackageIndex } from "./packages.js";
import { readUiIcons } from "./uiIcons.js";
import { collectVehicleConfigs } from "./vehicleConfigs.js";

type Props = Record<string, any>; // decoded game properties: shapes are checked field by field below

const props = (exp: RawExport | undefined): Props => (exp?.Properties ?? {}) as Props;
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const tag = (v: unknown): string | undefined => {
  const name = (v as { TagName?: unknown } | undefined)?.TagName;
  return typeof name === "string" && name !== "None" ? name : undefined;
};
const objectPath = (v: unknown): string | undefined => {
  const path = (v as { ObjectPath?: unknown } | undefined)?.ObjectPath;
  return typeof path === "string" && path !== "" ? path : undefined;
};
const text = (v: unknown): string | undefined => {
  const t = v as { LocalizedString?: string | null; SourceString?: string | null; CultureInvariantString?: string | null } | undefined;
  const raw = t?.LocalizedString ?? t?.SourceString ?? t?.CultureInvariantString;
  return raw?.replace(/\r\n?/g, "\n").trim() || undefined;
};
const stripPrefix = (value: string, prefix: string): string => (value.startsWith(prefix) ? value.slice(prefix.length) : value);
/** Drops properties that are undefined, so optional schema fields stay absent rather than null. */
const compact = <T extends object>(obj: T): T => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
const nonEmpty = <T extends object>(obj: T): T | undefined => (Object.keys(compact(obj)).length ? compact(obj) : undefined);
const CM_PER_M = 100;
const meters = (cm: number | undefined): number | undefined => (cm === undefined ? undefined : cm / CM_PER_M);

/** Parses a projectile data asset (`WDProjectileData`). `items` is filled in by the caller. */
export function parseProjectile(exp: RawExport, asset: string): Projectile | null {
  const p = props(exp);
  const id = tag(p.ProjectileId);
  const stats = p.ProjectileStats as Props | undefined;
  const damage = num(stats?.DamageValues?.BaseDamage);
  if (!id || !stats || damage === undefined) return null;

  const dims = stats.ProjectileDimensions as Props | undefined;
  const dragRow = dims?.DragModel?.Curve?.RowName;
  const drag = nonEmpty({
    coefficient: num(dims?.DragModel?.Value),
    model: typeof dragRow === "string" && dragRow !== "None" ? dragRow : undefined,
  });
  const diameter = num(dims?.Diameter);
  const length = num(dims?.Length);
  const radius = num(stats.DamageValues?.ExplosiveRadius);
  const effectiveRadius = num(stats.DamageValues?.EffectiveExplosiveRadius);

  return compact({
    id,
    asset,
    damage,
    damageType: tag(stats.DamageEntityData?.Tag),
    damageContext: strings(stats.DamageEntityData?.Context),
    massKg: num(dims?.Mass),
    diameterMm: diameter === undefined ? undefined : round(diameter * 10),
    lengthMm: length === undefined ? undefined : round(length * 10),
    drag,
    typicalSpeed: meters(num(stats.TypicalSpeed)),
    penetration: nonEmpty({
      penetrates: bool(stats.bShouldPenetrate),
      penetratesThinSurfaces: bool(stats.bForcePenetrateThinSurfaces),
      exitSpeedMultiplier: num(stats.PenetrationExitSpeedMultiplier),
      effectivenessMultiplier: num(stats.PenetrationEffectivenessMultiplier),
      ricochetMinAngle: num(stats.MinImpactAngleForRicochet),
    }),
    explosive: nonEmpty({
      radius: meters(radius),
      effectiveRadius: meters(effectiveRadius),
      falloff: num(stats.DamageValues?.ExplosiveDamageFallOff),
      minimumDamage: num(stats.DamageValues?.MinimumExplosiveDamage),
      bluntDamage: num(stats.DamageValues?.ExplosiveBluntDamage),
    }),
    suppression: num(stats.SuppressionData?.BaseSuppression),
    propulsion: nonEmpty({
      thrustSpeed: meters(num(stats.ThrustSpeed)),
      fuel: num(stats.TotalFuel),
      guided: bool(stats.GuidanceData?.bGuidedProjectile),
    }),
    items: [],
  }) as Projectile;
}

/** Rounds away float noise from unit conversions (0.5700000000000001 mm and the like). */
const round = (v: number): number => Math.round(v * 1e6) / 1e6;

/** The slots of an item definition, from its sub-slot fragment. */
export function parseSlots(exports: RawExport[]): WeaponSlot[] {
  const slots: WeaponSlot[] = [];
  for (const exp of exports) {
    if (exp.Type !== "BHInventoryFragment_SubSlotSupport") continue;
    for (const c of (props(exp).Containers ?? []) as Props[]) {
      const id = tag(c.ContainerIdentifier);
      if (!id) continue;
      const filter = c.Filter as Props | undefined;
      const first = strings(c.DefaultItems)[0];
      slots.push(
        compact({
          slot: stripPrefix(id, "Item.Attachment."),
          items: strings(filter?.AllowedSubSlotItems),
          contexts: strings(filter?.AllowedSubSlotContext),
          filter: stripPrefix(String(filter?.SupportFilter ?? ""), "EBHSupportFilterMethod::"),
          blockedItems: strings(filter?.BlockedSubSlotItems),
          blockedContexts: strings(filter?.BlockedSubSlotContext),
          default: first,
          hidden: bool(c.bIsHiddenContainer) ?? false,
        }) as WeaponSlot,
      );
    }
  }
  return slots;
}

/** Parses a weapon stats asset (`WDWeaponStatsData`) and joins it with the weapon's slots. */
export function parseWeapon(id: string, stats: RawExport, asset: string, slots: WeaponSlot[]): Weapon {
  const s = (props(stats).WeaponStats ?? {}) as Props;
  const range = (v: Props | undefined): [number, number] | undefined => {
    const a = num(v?.X);
    const b = num(v?.Y);
    return a === undefined || b === undefined ? undefined : [a, b];
  };
  const falloffKeys = (s.DistanceDamageFalloffCurve?.EditorCurveData?.Keys ?? []) as Props[];
  const damageFalloff =
    s.bUseDistanceDamageFalloffCurve === true && falloffKeys.length
      ? falloffKeys.map((k) => {
          const mode = String(k.InterpMode ?? "").replace("RCIM_", "");
          return { distance: (num(k.Time) ?? 0) / CM_PER_M, multiplier: num(k.Value) ?? 0, ...(mode === "Cubic" || mode === "Constant" ? { interpolation: mode } : {}) };
        })
      : undefined;
  const pattern = ((s.RecoilPattern ?? []) as Props[]).map((v) => ({ x: num(v.X) ?? 0, y: num(v.Y) ?? 0 }));
  const recoil =
    pattern.length > 0
      ? compact({
          pattern,
          patternResetTime: num(s.RecoilPatternResetTime),
          viewKickMultiplier: num(s.ViewKickMagnitudeMultiplier),
          afterPatternPitch: range(s.PostPatternRandomPitchRecoil),
          afterPatternYaw: range(s.PostPatternRandomYawRecoil),
        })
      : undefined;
  const shotgun = nonEmpty({
    chokeFactor: num(s.ShotgunData?.ChokeFactor),
    outerConeHalfAngle: num(s.ShotgunData?.OuterConeHalfAngle),
    innerConeMultiplier: num(s.ShotgunData?.InnerConeHalfAngleMultiplier),
    randomConeHalfAngleRange: range(s.ShotgunData?.RandomConeHalfAngleRange),
  });

  return compact({
    id,
    asset,
    fireModes: strings(s.SupportedFireModes).map((m) => stripPrefix(m, "EWDFireMode::")),
    rpm: num(s.RoundsPerMinute),
    roundsPerBurst: num(s.RoundsPerBurst),
    calibers: strings(s.SupportedCaliber).map((c) => stripPrefix(c, "Item.Caliber.")),
    muzzleVelocity: meters(num(s.InitialBulletSpeed)),
    effectiveRange: num(s.EffectiveRange),
    damageFalloff,
    accuracy: num(s.WeaponAccuracy?.AccuracyValue),
    randomDeviation: num(s.RandomDeviationDegree),
    adsTime: num(s.IronSightsAimTime),
    zeroing: nonEmpty({ min: num(s.MinZeroingRange), max: num(s.MaxZeroingRange), step: num(s.ZeroingStep) }),
    meleeDamage: num(s.MeleeDamage),
    suppressionMultiplier: num(s.SuppressionMultiplier),
    windupTime: num(s.WindupTime),
    recoil,
    shotgun,
    slots,
  }) as Weapon;
}

const MOD_OPS: Record<string, Modifier["op"]> = {
  "EBHAttributeModOp::MultiplyCompound": "multiplyCompound",
  "EBHAttributeModOp::Multiply": "multiply",
  "EBHAttributeModOp::Add": "add",
  "EBHAttributeModOp::Override": "override",
};

export interface ParsedModifiers {
  modifiers: Modifier[];
  /** Modifiers whose value is computed at runtime (curves, data tags) and so is not a plain number. */
  skipped: number;
}

/**
 * Reads the attribute modifiers of a gameplay effect package. Only fixed numbers are kept: a modifier that does
 * nothing (multiply by 1, add 0) is dropped, and one whose value comes from a curve or a runtime tag is counted in
 * `skipped`. Modifiers of the same attribute and operation stay separate, in the game's order.
 */
export function parseModifiers(exports: RawExport[]): ParsedModifiers {
  const modifiers: Modifier[] = [];
  let skipped = 0;
  for (const exp of exports) {
    for (const m of (props(exp).Modifiers ?? []) as Props[]) {
      const attribute = tag(m.Attribute);
      const op = MOD_OPS[String(m.Operation)];
      const scalar = m.Modifier?.Scalar as Props | undefined;
      const value = num(scalar?.Value);
      const fromCurve = scalar?.Curve?.CurveTable != null || m.Modifier?.CurveIndexing !== "EBHAttributeScalarIndex::Fixed";
      if (!attribute || !op || value === undefined || fromCurve) {
        skipped++;
        continue;
      }
      const noop = (op === "multiply" || op === "multiplyCompound") ? value === 1 : op === "add" ? value === 0 : false;
      if (noop) continue;
      modifiers.push({ attribute: stripPrefix(attribute, "Attribute.Gameplay."), op, value });
    }
  }
  return { modifiers, skipped };
}

/** Raw item definition: every export of an `ID_*` package. */
export interface ItemDefinition {
  id: string;
  asset: string;
  exports: RawExport[];
}

const definitionProps = (def: ItemDefinition): Props => props(def.exports.find((e) => e.Type === "BHInventoryItemDefinition"));
const fragment = (def: ItemDefinition, type: string): RawExport | undefined => def.exports.find((e) => e.Type === type);

/** How many rounds a magazine holds and which calibers it takes, from its ammo container. */
export function parseMagazine(exports: RawExport[]): Attachment["magazine"] {
  for (const slot of parseSlots(exports)) {
    if (slot.slot !== "Item.Ammo") continue;
    const container = exports
      .flatMap((e) => ((props(e).Containers ?? []) as Props[]))
      .find((c) => tag(c.ContainerIdentifier) === "Item.Ammo");
    const capacity = num(container?.MaxSlotAmountStackSize);
    if (capacity === undefined || capacity < 1) continue;
    return { capacity, calibers: slot.contexts.filter((c) => c.startsWith("Item.Caliber.")).map((c) => stripPrefix(c, "Item.Caliber.")) };
  }
  return undefined;
}

/** Parses an attachment item: its type, tags, modifiers and (for magazines) capacity. */
export function parseAttachment(def: ItemDefinition, index: Pick<PackageIndex, "load">): { attachment: Attachment; skipped: number } | null {
  const frag = fragment(def, "WDInventoryFragment_Attachment");
  if (!frag) return null;
  const data = (props(frag).AttachmentData ?? {}) as Props;
  const type = tag(data.AttachmentType);
  if (!type) return null;

  let skipped = 0;
  const collect = (effects: unknown): Modifier[] =>
    ((effects ?? []) as Props[]).flatMap((effect) => {
      const exports = index.load(objectPath(effect));
      if (!exports) return [];
      const parsed = parseModifiers(exports);
      skipped += parsed.skipped;
      return parsed.modifiers;
    });

  const attachment = compact({
    id: def.id,
    type: stripPrefix(type, "Item.Attachment."),
    contexts: strings(definitionProps(def).ItemContext),
    modifiers: collect(data.AppliedEffects),
    characterModifiers: collect(data.AppliedCharacterEffects),
    magazine: parseMagazine(def.exports),
  }) as Attachment;
  return { attachment, skipped };
}

/** Parses an armor or helmet item: what it covers, how much it absorbs as it wears, and its effects on the wearer. */
export function parseArmor(def: ItemDefinition, index: Pick<PackageIndex, "load">): { armor: Armor; skipped: number } | null {
  const frag = fragment(def, "WDInventoryFragment_Armor");
  if (!frag) return null;
  const p = props(frag);
  const damageContext = tag(p.DamageContextTag);
  const slot = strings(definitionProps(def).ItemContext).find((c) => c.startsWith("Inventory.Slot."));
  if (!damageContext || !slot) return null;
  let skipped = 0;
  const modifiers = ((p.AppliedEffects ?? []) as Props[]).flatMap((effect) => {
    const exports = index.load(objectPath(effect));
    if (!exports) return [];
    const parsed = parseModifiers(exports);
    skipped += parsed.skipped;
    return parsed.modifiers;
  });
  const armor = compact({
    id: def.id,
    slot: stripPrefix(slot, "Inventory.Slot."),
    damageContext: stripPrefix(damageContext, "Meta.Damage."),
    coveredLocations: strings(p.CoveredHitLocations).map((l) => stripPrefix(l, "Meta.Damage.HitLocation.Infantry.")),
    durability: num(p.ReplicatedData?.Durability),
    stages: ((p.DurabilityStagesSetupData ?? []) as Props[]).map((s) => ({
      damageReduction: num(s.DamagePercentageReduction) ?? 0,
      thickness: num(s.Thickness) ?? 0,
      density: num(s.Density) ?? 0,
    })),
    modifiers,
  }) as Armor;
  return { armor, skipped };
}

/** Parses the carried-weight tiers (`WDMoverWeightData`): minimum weight in grams and the effect applied. */
export function parseWeightClasses(exp: RawExport, index: Pick<PackageIndex, "load">): WeightClass[] {
  const classes = ((props(exp).WeightClasses ?? []) as Props[]).flatMap((c) => {
    const name = tag(c.Key);
    const minWeight = num(c.Value?.MinWeight);
    if (!name || minWeight === undefined) return [];
    const effects = index.load(objectPath(c.Value?.Effect));
    return [{ name: stripPrefix(name, "State.Player.Weight."), minWeightKg: minWeight / 1000, modifiers: effects ? parseModifiers(effects).modifiers : [] }];
  });
  return classes.sort((a, b) => a.minWeightKg - b.minWeightKg);
}

/**
 * What the game calls a vehicle's damage entity when it is not simply the variant id without `Variant.`. The Kodiak's
 * entity carries the name of its maker. Everything else resolves by dropping trailing segments (see `resolveSystemsEntity`).
 */
export const VEHICLE_ENTITY_OVERRIDES: Readonly<Record<string, string>> = {
  "Vehicle.Land.Wheeled.Kodiak": "Vehicle.Land.Wheeled.Patriot.Kodiak",
};

/**
 * The damage entity (without `Meta.Damage.`) of the gameplay systems asset a variant uses: the variant id without
 * `Variant.`, shortened a segment at a time until a systems asset with that entity exists. Variants of one platform
 * (the three Ural variants, say) share one. Case does not matter. Returns undefined when nothing matches.
 */
export function resolveSystemsEntity(variantId: string, known: ReadonlySet<string>): string | undefined {
  const lower = new Map([...known].map((k) => [k.toLowerCase(), k]));
  const parts = stripPrefix(variantId, "Vehicle.Variant.").split(".");
  for (let n = parts.length; n >= 2; n--) {
    const candidate = `Vehicle.${parts.slice(0, n).join(".")}`;
    const wanted = VEHICLE_ENTITY_OVERRIDES[candidate] ?? candidate;
    const hit = lower.get(wanted.toLowerCase());
    if (hit) return hit;
  }
  return undefined;
}

/** Health, fuel and wreck explosion from a vehicle gameplay systems asset (`WDVehicleGameplayComponentsDataAsset`). */
export function parseVehicleSystems(exp: RawExport): { entity: string; details: Pick<Vehicle, "health" | "kmPerLiter" | "destroyedExplosion"> } | null {
  const p = props(exp);
  const damageTag = tag(p.DamageEntitySettings?.VehicleDamageTag);
  if (!damageTag) return null;
  const initial = num(p.HealthSettings?.InitialVehicleHealth);
  const explosion = p.DamageEntitySettings?.DestroyedExplosionDamageValues as Props | undefined;
  const kml = num(p.FuelSettings?.KML);
  return {
    entity: stripPrefix(damageTag, "Meta.Damage."),
    details: compact({
      health: initial !== undefined && initial > 0 ? compact({ initial, criticalThreshold: num(p.HealthSettings?.CriticalStateThreshold), bleedOutTime: num(p.HealthSettings?.BleedOutTimer) }) : undefined,
      kmPerLiter: kml !== undefined && kml > 0 ? kml : undefined,
      destroyedExplosion: nonEmpty({ radius: meters(num(explosion?.ExplosiveRadius)), effectiveRadius: meters(num(explosion?.EffectiveExplosiveRadius)), falloff: num(explosion?.ExplosiveDamageFallOff) }),
    }) as Pick<Vehicle, "health" | "kmPerLiter" | "destroyedExplosion">,
  };
}

type VehiclePhysics = Pick<Vehicle, "mass" | "engine" | "transmission" | "tracks">;

/** The keys of a `CurveFloat` asset as rpm and torque pairs, sorted by rpm. `ref` is the property that points at it. */
function parseTorqueCurve(ref: unknown, index: Pick<PackageIndex, "loadExport">): { rpm: number; torque: number }[] {
  const path = objectPath(ref) ?? objectPath((ref as Props | undefined)?.ExternalCurve);
  const keys = (props(index.loadExport(path, "CurveFloat")).FloatCurve?.Keys ?? []) as Props[];
  return keys.flatMap((k) => (num(k.Time) !== undefined && num(k.Value) !== undefined ? [{ rpm: k.Time as number, torque: k.Value as number }] : [])).sort((a, b) => a.rpm - b.rpm);
}

/**
 * Mass, engine and gearbox from a vehicle config asset, which names the physics assets of its family: wheeled
 * (`MWheeledVehicleConfigDataAsset`: characteristics and engine/transmission), helicopter (`BHRotaryVehicleConfigDataAsset`:
 * body mass override) and tracked (`MTrackedVehicleConfigDataAsset`: engine data). Properties the game leaves at their
 * default are not stored in its files and stay absent here.
 */
export function parseVehiclePhysics(config: RawExport, index: Pick<PackageIndex, "loadExport">): VehiclePhysics {
  const p = props(config);
  let mass: number | undefined;
  let engine: Vehicle["engine"];
  let transmission: Vehicle["transmission"];
  let tracks: Vehicle["tracks"];
  const wheeled = props(index.loadExport(objectPath(p.CharacteristicsDataAsset), "MWheeledVehicleCharacteristicsDataAsset"));
  mass = num(wheeled.Mass);
  const body = props(index.loadExport(objectPath(p.RotaryVehicleBodyDataAsset), "BHRotaryVehicleBodyDataAsset"));
  if (body.bEnableMassOverride === true) mass ??= num(body.MassOverride);

  const drive = props(index.loadExport(objectPath(p.EngineTransmissionDataAsset), "MWheeledVehicleEngineTransmissionDataAsset"));
  if (drive.EngineData) {
    const e = drive.EngineData as Props;
    engine = {
      torqueCurve: parseTorqueCurve(e.TorqueCurve, index),
      ...compact({ torqueScale: num(e.TorqueScale), frictionTorque: num(e.FrictionTorque), idleRpm: num(e.IdleRPM), limitRpm: num(e.LimitRpm), inertia: num(e.EngineInertia), boostScale: num(e.BoostScale) }),
    };
    const t = (drive.TransmissionData ?? {}) as Props;
    transmission = {
      gearRatios: ((t.GearRatios ?? []) as unknown[]).filter((g): g is number => num(g) !== undefined),
      ...compact({ finalGearRatio: num(t.FinalGearRatio), changeTime: num(t.ChangeTime), clutchTime: num(t.ClutchTime), gearUpRatio: num(t.GearUpRatio), gearDownRatio: num(t.GearDownRatio) }),
    };
  }
  const tracked = props(index.loadExport(objectPath(p.TrackedVehicleEngineData), "MTrackedVehicleEngineData"));
  if (tracked.TorqueCurve) {
    engine = { torqueCurve: parseTorqueCurve(tracked.TorqueCurve, index), ...compact({ boostScale: num(tracked.BoostScale), extraPowerRatio: num(tracked.EngineExtraPowerRatio) }) };
    transmission = {
      gearRatios: ((tracked.GearRatios ?? []) as unknown[]).filter((g): g is number => num(g) !== undefined),
      ...compact({ finalGearRatio: num(tracked.DifferentialRatio), changeTime: num(tracked.ChangeTime) }),
    };
    tracks = nonEmpty({ trackMass: num(tracked.TrackMass), sprocketMass: num(tracked.SprocketMass) });
  }
  return compact({ mass, engine, transmission, tracks });
}

/** Parses a vehicle stats asset (`WDVehicleStatsDataAsset`). */
export function parseVehicleStats(id: string, exp: RawExport, asset: string): Vehicle | null {
  const p = props(exp);
  const maxSpeed = num(p.MaxSpeed);
  const maxFuel = num(p.MaxFuel);
  const fuelEconomy = num(p.FuelEconomy);
  const seats = num(p.MaxSeats);
  if (maxSpeed === undefined || maxFuel === undefined || fuelEconomy === undefined || seats === undefined) return null;
  const names = (v: unknown): string[] => ((v ?? []) as unknown[]).map(text).filter((t): t is string => t !== undefined);
  return { id, asset, maxSpeed, maxFuel, fuelEconomy, seats, weapons: names(p.VehicleWeaponryNames), counterMeasures: names(p.VehicleCounterMeasuresNames) };
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

export interface GameplayBuild {
  files: GeneratedFile[];
  notes: string[];
}

const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";
const byId = <T extends { id: string }>(a: T, b: T): number => a.id.localeCompare(b.id);

/** Reads every item definition (`ID_*`) in the items cache. */
export function readItemDefinitions(itemsDir: string): ItemDefinition[] {
  const out: ItemDefinition[] = [];
  for (const file of walk(itemsDir)) {
    if (!/[\\/]ID_[^\\/]*\.json$/.test(file)) continue;
    const exports = JSON.parse(readFileSync(file, "utf8")) as RawExport[];
    const main = exports.find((e) => e.Type === "BHInventoryItemDefinition");
    const id = tag(props(main).ItemId);
    if (!id) continue;
    const asset = file.slice(itemsDir.length).replaceAll("\\", "/").replace(/^\/+/, "").replace(/^Wardogs\//, "").replace(/\.json$/, "");
    out.push({ id, asset, exports });
  }
  return out;
}

/** Vendor tables, for the vehicle rows that name their stats asset. */
function vehicleStatsLinks(itemsDir: string): Map<string, string> {
  const links = new Map<string, string>();
  for (const file of walk(itemsDir)) {
    if (!/[\\/]DT_[^\\/]*Market[^\\/]*\.json$/.test(file)) continue;
    for (const exp of JSON.parse(readFileSync(file, "utf8")) as RawExport[]) {
      if (exp.Type !== "DataTable" || !exp.Rows) continue;
      for (const row of Object.values(exp.Rows) as Props[]) {
        for (const v of (row.VendorItemVariations ?? []) as Props[]) {
          const id = tag(v.VariationTag);
          const stats = objectPath(v.VehicleStatsDataAsset);
          if (id && stats && !links.has(id)) links.set(id, stats);
        }
      }
    }
  }
  return links;
}

/** Builds ammo, weapons, attachments and vehicles from the raw cache, without touching the disk. */
export function buildGameplayData(rawDir: string, gameBuild: string): GameplayBuild {
  const itemsDir = join(rawDir, "items");
  const gameplayDir = join(rawDir, "gameplay");
  if (!existsSync(gameplayDir)) throw new Error("The gameplay cache is empty. Run `pnpm extract gameplay` first.");
  const index = new PackageIndex([itemsDir, gameplayDir]);
  const definitions = readItemDefinitions(itemsDir);
  const notes: string[] = [];
  const uiText = readUiIcons(itemsDir, join(rawDir, ICONS_DIR));
  // Names are the ones items.json carries, from the same transform, so the stat files and items.json cannot disagree.
  const itemNames = new Map((JSON.parse(buildItemsData(itemsDir, gameBuild).content) as { items: Array<{ id: string; name?: string }> }).items.map((i) => [i.id.toLowerCase(), i.name]));
  /** Puts the item's name right after the id, so the stat files read like items.json. */
  const named = <T extends { id: string }>(list: T[]): Array<T & { name?: string }> =>
    list.map((x) => {
      const name = itemNames.get(x.id.toLowerCase());
      if (!name) return x;
      const { id, ...rest } = x;
      return { id, name, ...rest } as T & { name?: string };
    });

  // Ammo: every projectile asset, joined with the ammo items that fire it.
  const projectiles = new Map<string, Projectile>();
  for (const { asset, export: exp } of index.findAll("WDProjectileData")) {
    const parsed = parseProjectile(exp, asset);
    if (parsed) projectiles.set(asset, parsed);
  }
  for (const def of definitions) {
    const asset = index.asset(objectPath(props(fragment(def, "WDInventoryFragment_Projectile")).ProjectileData));
    const projectile = asset ? projectiles.get(asset) : undefined;
    if (projectile) projectile.items.push(def.id);
  }
  const ammo = [...projectiles.values()].map((p) => ({ ...p, items: [...p.items].sort() })).sort((a, b) => a.id.localeCompare(b.id) || a.asset.localeCompare(b.asset));
  const unused = ammo.filter((p) => p.items.length === 0).length;
  notes.push(`ammo: ${ammo.length} projectiles, ${unused} not fired by any item`);

  // Weapons: items that point at a weapon stats asset.
  const weapons: Weapon[] = [];
  for (const def of definitions) {
    const ranged = fragment(def, "WDItemExtensionData_RangedWeapon");
    const statsPath = objectPath(props(ranged).WeaponStats);
    if (!statsPath) continue;
    const stats = index.loadExport(statsPath, "WDWeaponStatsData");
    if (!stats) {
      notes.push(`warning: weapon ${def.id} points at stats ${statsPath}, which is not in the cache`);
      continue;
    }
    weapons.push(parseWeapon(def.id, stats, index.asset(statsPath) ?? statsPath, parseSlots(def.exports)));
  }
  weapons.sort(byId);
  notes.push(`weapons: ${weapons.length}, ${weapons.filter((w) => w.recoil).length} with recoil patterns`);

  // Attachments: items with an attachment fragment.
  const attachments: Attachment[] = [];
  let skipped = 0;
  for (const def of definitions) {
    const parsed = parseAttachment(def, index);
    if (!parsed) continue;
    attachments.push(parsed.attachment);
    skipped += parsed.skipped;
  }
  attachments.sort(byId);
  notes.push(
    `attachments: ${attachments.length}, ${attachments.filter((a) => a.modifiers.length + a.characterModifiers.length > 0).length} with modifiers, ${attachments.filter((a) => a.magazine).length} magazines`,
  );
  if (skipped) notes.push(`note: ${skipped} attachment modifiers use runtime values and are not included`);

  // Vehicles: vendor rows that name a stats asset.
  const systems = new Map<string, ReturnType<typeof parseVehicleSystems> & object>();
  for (const { export: exp } of index.findAll("WDVehicleGameplayComponentsDataAsset")) {
    const parsed = parseVehicleSystems(exp);
    if (parsed) systems.set(parsed.entity, parsed);
  }
  // Physics: every vehicle config names its gameplay systems asset, which gives the damage entity it belongs to.
  const physics = new Map<string, VehiclePhysics[]>();
  for (const type of ["MWheeledVehicleConfigDataAsset", "BHRotaryVehicleConfigDataAsset", "MTrackedVehicleConfigDataAsset"]) {
    for (const { export: exp } of index.findAll(type)) {
      const entity = parseVehicleSystems(index.loadExport(objectPath(props(exp).GameplayConfigDataAsset), "WDVehicleGameplayComponentsDataAsset") ?? ({} as RawExport))?.entity;
      if (!entity) continue;
      physics.set(entity, [...(physics.get(entity) ?? []), parseVehiclePhysics(exp, index)]);
    }
  }
  const vehiclePhysics = (entity: string): VehiclePhysics | undefined => {
    const all = physics.get(entity);
    if (!all) return undefined;
    // Variants of one platform can have separate configs; they must agree, or no value is published.
    if (all.some((x) => JSON.stringify(x) !== JSON.stringify(all[0]))) {
      notes.push(`warning: the configs of ${entity} disagree on mass and engine, so none is published`);
      return undefined;
    }
    return all[0];
  };
  const vehicles: Vehicle[] = [];
  for (const [id, statsPath] of vehicleStatsLinks(itemsDir)) {
    const stats = index.loadExport(statsPath, "WDVehicleStatsDataAsset");
    const parsed = stats ? parseVehicleStats(id, stats, index.asset(statsPath) ?? statsPath) : null;
    if (!parsed) {
      notes.push(`warning: vehicle ${id} has no readable stats at ${statsPath}`);
      continue;
    }
    const entity = resolveSystemsEntity(id, new Set(systems.keys()));
    if (entity) vehicles.push({ ...parsed, damageEntity: entity, ...systems.get(entity)!.details, ...vehiclePhysics(entity) });
    else {
      vehicles.push(parsed);
      notes.push(`warning: vehicle ${id} matches no gameplay systems asset, so it has no health`);
    }
  }
  // Weapon icons: the UI tables name each vehicle weapon extension (`Id.Vehicle.WeaponExtension.*`) like the shop lists it.
  const weaponIcon = new Map<string, string | null>();
  for (const [id, ui] of uiText) {
    if (!id.includes(".weaponextension.") || !ui.name || !ui.icon) continue;
    weaponIcon.set(ui.name, weaponIcon.has(ui.name) && weaponIcon.get(ui.name) !== ui.icon ? null : ui.icon); // two icons for one name: none
  }
  for (const [name, icon] of weaponIcon) if (icon === null) notes.push(`warning: the vehicle weapon ${name} has two different icons, so none is published`);
  for (const vehicle of vehicles) {
    const icons = Object.fromEntries(vehicle.weapons.flatMap((w) => (weaponIcon.get(w) ? [[w, weaponIcon.get(w)!]] : [])));
    if (Object.keys(icons).length) vehicle.weaponIcons = icons;
  }
  vehicles.sort(byId);
  notes.push(`vehicles: ${vehicles.length} with stats, ${vehicles.filter((v) => v.weaponIcons).length} with weapon icons`);
  const vehicleConfigs = collectVehicleConfigs(
    index,
    (pkg) => {
      const systemsExport = index.loadExport(pkg, "WDVehicleGameplayComponentsDataAsset");
      return systemsExport ? parseVehicleSystems(systemsExport)?.entity : undefined;
    },
    (entity) => vehicles.filter((v) => v.damageEntity === entity).map((v) => v.id),
  );
  notes.push(`vehicle configs: ${vehicleConfigs.configs.length} configs, ${vehicleConfigs.assets.length} assets, ${vehicleConfigs.unresolved.length} references not decoded`);

  // Equipment: armor items, and the carried-weight tiers.
  const armor: Armor[] = [];
  for (const def of definitions) {
    const parsed = parseArmor(def, index);
    if (!parsed) continue;
    armor.push(parsed.armor);
    skipped += parsed.skipped;
  }
  armor.sort(byId);
  const [weightExport] = [...index.findAll("WDMoverWeightData")];
  const weightClasses = weightExport ? parseWeightClasses(weightExport.export, index) : [];
  if (!weightExport) notes.push("warning: no carried-weight tiers found");
  notes.push(`equipment: ${armor.length} armor items, ${weightClasses.length} weight classes`);

  const header = { schemaVersion: 1 as const, gameBuild };
  return {
    files: [
      { path: "data/ammo.json", content: json(AmmoFile.parse({ ...header, units: "meters", projectiles: ammo })) },
      { path: "data/weapons.json", content: json(WeaponsFile.parse({ ...header, units: "meters", weapons: named(weapons) })) },
      { path: "data/attachments.json", content: json(AttachmentsFile.parse({ ...header, attachments: named(attachments) })) },
      { path: "data/vehicles.json", content: json(VehiclesFile.parse({ ...header, vehicles: named(vehicles) })) },
      { path: "data/vehicle-configs.json", content: json(VehicleConfigsFile.parse({ ...header, ...vehicleConfigs })) },
      { path: "data/equipment.json", content: json(EquipmentFile.parse({ ...header, armor: named(armor), weightClasses })) },
    ],
    notes,
  };
}
