import { z } from "zod";

/** Fields every generated gameplay file starts with. */
const header = {
  schemaVersion: z.literal(1).describe("Version of this file's layout. It changes only when the layout does."),
  gameBuild: z.string().describe("Steam build id the data was extracted from."),
};

const Num = z.number().finite();

export const Projectile = z.object({
  id: z.string().min(1).describe("Projectile id from the game, for example `Item.Caliber.556mm`."),
  asset: z.string().min(1).describe("Path of the projectile data asset inside the game files."),
  damage: Num.nonnegative().describe("Damage of one hit before distance falloff, armor and hit location."),
  damageType: z.string().optional().describe("Damage type tag, for example `Meta.Damage.Bullet.556mm`."),
  damageContext: z.array(z.string()).describe("Extra damage context tags, for example the body parts the type is tuned for."),
  massKg: Num.nonnegative().optional().describe("Projectile mass in kilograms."),
  diameterMm: Num.nonnegative().optional().describe("Projectile diameter in millimeters."),
  lengthMm: Num.nonnegative().optional().describe("Projectile length in millimeters."),
  drag: z.object({ coefficient: Num.optional().describe("Drag coefficient."), model: z.string().optional().describe("Name of the drag model (a row of the game's drag table), for example `G7 (Boat Tail)`.") }).optional().describe("Aerodynamic drag: the coefficient and, when the game names one, the drag model it comes from (such as G7)."),
  typicalSpeed: Num.nonnegative().optional().describe("The speed the game treats as typical for the projectile. Weapons set their own muzzle velocity."),
  penetration: z
    .object({
      penetrates: z.boolean().optional().describe("False when the projectile never passes through surfaces. Absent when the game does not say."),
      penetratesThinSurfaces: z.boolean().optional().describe("True when the projectile always passes through thin surfaces."),
      exitSpeedMultiplier: Num.optional().describe("Fraction of the speed kept after passing through a surface."),
      effectivenessMultiplier: Num.optional().describe("Multiplier on how well the projectile penetrates, as stored."),
      ricochetMinAngle: Num.optional().describe("Impact angle in degrees above which the projectile ricochets."),
    })
    .optional().describe("How the projectile behaves against surfaces. Absent when the game defines nothing."),
  explosive: z
    .object({
      radius: Num.nonnegative().optional().describe("Distance at which damage has fallen to its minimum."),
      effectiveRadius: Num.nonnegative().optional().describe("Distance within which full damage applies."),
      falloff: Num.optional().describe("How fast explosive damage falls with distance, as stored."),
      minimumDamage: Num.nonnegative().optional().describe("Least damage inside the radius."),
      bluntDamage: Num.nonnegative().optional().describe("Blunt (non-penetrating) damage of the explosion."),
    })
    .optional().describe("Area damage. Absent for projectiles that do none."),
  suppression: Num.nonnegative().optional().describe("Suppression a near miss causes."),
  propulsion: z
    .object({
      thrustSpeed: Num.optional().describe("Speed in meters per second the motor accelerates the projectile to."),
      fuel: Num.optional().describe("Motor fuel, as stored."),
      guided: z.boolean().optional().describe("True when the projectile steers after launch."),
    })
    .optional().describe("Set for rockets and missiles that keep accelerating or steer after launch."),
  items: z.array(z.string()).describe("Ammo items (ids from items.json) that fire this projectile."),
}).describe("Ammunition ballistics: one entry per projectile definition. Several ammo items can share one (the armor-piercing and hollow-point variants of a caliber use the same definition and differ in the damage rules, which are not extracted). Distances are meters, speeds meters per second, mass kilograms, size millimeters.");
export type Projectile = z.infer<typeof Projectile>;

export const AmmoFile = z.object({ ...header, units: z.literal("meters").describe("Unit of every distance in the file. Speeds are meters per second."), projectiles: z.array(Projectile).describe("One entry per projectile definition, sorted by id.") }).describe("Ammunition ballistics: damage, size, drag, penetration and explosive data per projectile, with the ammo items that fire each one.");
export type AmmoFile = z.infer<typeof AmmoFile>;

export const WeaponSlot = z.object({
  slot: z.string().min(1).describe("Slot type, for example `Sight` or `Magazine` (the game's `Item.Attachment.*` tag without its prefix)."),
  items: z.array(z.string()).describe("Items accepted by name."),
  contexts: z.array(z.string()).describe("Item context tags accepted: anything carrying one of these tags fits."),
  filter: z.string().describe("The game's filter mode: `AllowList` accepts only the listed items and contexts, `BlockPriority` accepts all except what is blocked."),
  blockedItems: z.array(z.string()).describe("Items refused by name."),
  blockedContexts: z.array(z.string()).describe("Context tags refused."),
  default: z.string().optional().describe("Item the weapon starts with in this slot."),
  hidden: z.boolean().describe("Slot is not shown to players (chamber, built-in parts)."),
}).describe("One attachment slot on a weapon.");
export type WeaponSlot = z.infer<typeof WeaponSlot>;

export const Weapon = z.object({
  id: z.string().min(1).describe("Item id from items.json."),
  name: z.string().optional().describe("Display name, as in items.json (the game's UI table). Absent when the game has none."),
  asset: z.string().min(1).describe("Path of the weapon stats asset inside the game files."),
  fireModes: z.array(z.string()).describe("Fire modes: `Automatic`, `SemiAutomatic`, `Burst`."),
  rpm: Num.nonnegative().optional().describe("Rounds per minute."),
  roundsPerBurst: Num.int().positive().optional().describe("Rounds fired per burst."),
  calibers: z.array(z.string()).describe("Calibers the weapon fires (the game's `Item.Caliber.*` tags without the prefix)."),
  muzzleVelocity: Num.nonnegative().optional().describe("Muzzle velocity in meters per second."),
  effectiveRange: Num.nonnegative().optional().describe("Range in meters the game tunes the weapon for."),
  damageFalloff: z.array(z.object({ distance: Num.nonnegative().describe("Distance in meters."), multiplier: Num.nonnegative().describe("Damage multiplier at that distance (1 is full damage)."), interpolation: z.enum(["Cubic", "Constant"]).optional().describe("How the game interpolates from this point to the next, when it is not linear. Absent means linear. A cubic segment follows the game's own tangents, which are not published, so treat it as a smooth curve between the two points.") })).optional().describe("Damage multiplier by distance. Between points the game interpolates as each point's `interpolation` says (linear when absent), and holds the first value before the first point and the last after the last."),
  accuracy: Num.optional().describe("Accuracy rating as stored. Larger values go with looser weapons in the data (SV98 0.56, AK74M 0.825, M500 1.5, RPG-7 3.0), so compare weapons of one class."),
  randomDeviation: Num.optional().describe("Random aim deviation in degrees."),
  adsTime: Num.optional().describe("Seconds to aim down sights through iron sights."),
  zeroing: z.object({ min: Num.optional().describe("Shortest zeroing distance."), max: Num.optional().describe("Longest zeroing distance."), step: Num.optional().describe("Distance between zeroing settings.") }).optional().describe("Sight zeroing range in meters. Absent for weapons without zeroing."),
  meleeDamage: Num.optional().describe("Damage of a melee hit."),
  suppressionMultiplier: Num.optional().describe("Multiplier on the suppression the weapon causes."),
  windupTime: Num.optional().describe("Seconds between pulling the trigger and the first shot, for weapons that spin up."),
  recoil: z
    .object({
      pattern: z.array(z.object({ x: Num.describe("Sideways kick of this shot."), y: Num.describe("Upward kick of this shot.") })).describe("The game's `RecoilPattern`: one x and y pair per shot, as stored. In the data x is sideways and y is upward for nearly every shot (a few shots of two weapons pull slightly down); the game gives no unit."),
      patternResetTime: Num.optional().describe("Seconds without firing before the pattern restarts."),
      viewKickMultiplier: Num.optional().describe("Multiplier on the camera kick."),
      afterPatternPitch: z.tuple([Num, Num]).optional().describe("Random extra upward kick once the pattern has ended, [min, max], as stored (the game's `PostPatternRandomPitchRecoil`)."),
      afterPatternYaw: z.tuple([Num, Num]).optional().describe("Random extra sideways kick once the pattern has ended, [min, max], as stored (the game's `PostPatternRandomYawRecoil`)."),
    })
    .optional().describe("Recoil. Absent for weapons the game gives no pattern."),
  shotgun: z
    .object({
      chokeFactor: Num.optional().describe("Choke, as stored (higher tightens the spread)."),
      outerConeHalfAngle: Num.optional().describe("Half angle of the outer spread cone, in degrees."),
      innerConeMultiplier: Num.optional().describe("Inner cone size as a multiple of the outer cone."),
      randomConeHalfAngleRange: z.tuple([Num, Num]).optional().describe("Random extra half angle added to the cone: [min, max] in degrees."),
    })
    .optional().describe("Spread of a shotgun's pellets. Absent for other weapons."),
  slots: z.array(WeaponSlot).describe("Attachment slots from the weapon's item definition."),
});
export type Weapon = z.infer<typeof Weapon>;

export const WeaponsFile = z.object({ ...header, units: z.literal("meters").describe("Unit of every distance in the file. Speeds are meters per second."), weapons: z.array(Weapon).describe("One entry per weapon, sorted by item id.") }).describe("Weapon statistics (fire rate, ballistics, recoil, accuracy) and the attachment slots of each weapon. Weapon ids are item ids from items.json.");
export type WeaponsFile = z.infer<typeof WeaponsFile>;

export const Modifier = z.object({
  attribute: z.string().min(1).describe("Attribute, for example `Weapon.AimTime` (the game's `Attribute.Gameplay.*` tag without the prefix)."),
  op: z.enum(["multiplyCompound", "multiply", "add", "override"]).describe("How the value combines: `multiplyCompound` and `multiply` scale the attribute (1.1 is +10%), `add` adds, `override` replaces. Several `multiplyCompound` modifiers multiply together."),
  value: Num.describe("The number applied. For `multiply` and `multiplyCompound`, 1.1 means +10%."),
}).describe("One change an attachment makes to a gameplay attribute.");
export type Modifier = z.infer<typeof Modifier>;

export const Attachment = z.object({
  id: z.string().min(1).describe("Item id from items.json."),
  name: z.string().optional().describe("Display name, as in items.json (the game's UI table). Absent when the game has none."),
  type: z.string().min(1).describe("Attachment type, for example `Magazine`, `Muzzle`, `Sight` (the game's `Item.Attachment.*` tag)."),
  contexts: z.array(z.string()).describe("Item context tags, which weapon slots match against."),
  modifiers: z.array(Modifier).describe("Changes applied to the weapon while the attachment is fitted."),
  characterModifiers: z.array(Modifier).describe("Changes applied to the character carrying the weapon, such as sway."),
  magazine: z.object({ capacity: Num.int().positive().describe("Rounds the magazine holds."), calibers: z.array(z.string()).describe("Calibers the magazine takes (the game's `Item.Caliber.*` tags without the prefix).") }).optional().describe("Magazines: how many rounds fit, and which calibers."),
});
export type Attachment = z.infer<typeof Attachment>;

export const AttachmentsFile = z.object({ ...header, attachments: z.array(Attachment).describe("One entry per attachment item, sorted by item id.") }).describe("Weapon attachments: the attribute changes each one makes, and capacity and calibers for magazines. Ids are item ids from items.json.");
export type AttachmentsFile = z.infer<typeof AttachmentsFile>;

export const Vehicle = z
  .object({
    id: z.string().min(1).describe("Vehicle variant id from items.json."),
    name: z.string().optional().describe("Display name, as in items.json (the game's UI table). Absent when the game has none."),
    asset: z.string().min(1).describe("Path of the vehicle stats asset inside the game files."),
    maxSpeed: z.number().finite().nonnegative().describe("Top speed as shown in the vehicle shop (km/h)."),
    maxFuel: z.number().finite().nonnegative().describe("Fuel tank size in liters."),
    fuelEconomy: z.number().finite().nonnegative().describe("Fuel use as shown in the shop, in liters per kilometer (the shop rounds `1 / kmPerLiter` to one decimal)."),
    seats: z.number().int().positive().describe("Number of seats."),
    weapons: z.array(z.string()).describe("Names of the weapons listed in the shop."),
    weaponIcons: z.record(z.string(), z.string()).optional().describe("Icon of each weapon in `weapons` that the game has one for, by weapon name: a path inside `assets/icons/`. The game's UI tables name the vehicle's weapon extensions with the same names."),
    counterMeasures: z.array(z.string()).describe("Names of the countermeasures listed in the shop."),
    damageEntity: z.string().optional().describe("The `entity` of this vehicle's damage rules in damage.json, such as `Vehicle.Land.Wheeled.Humvee.Default`. Variants of one platform can share it."),
    health: z
      .object({
        initial: z.number().finite().positive().describe("Hit points of a new vehicle."),
        criticalThreshold: z.number().finite().optional().describe("Health at or below which the vehicle is in a critical state, as stored."),
        bleedOutTime: z.number().finite().optional().describe("Seconds a vehicle in the critical state lasts before it is destroyed, as stored."),
      })
      .optional()
      .describe("Vehicle health. Absent when the vehicle has no gameplay systems asset."),
    kmPerLiter: z.number().finite().positive().optional().describe("Distance in kilometers one liter of fuel lasts, as stored (`1 / kmPerLiter` is liters per kilometer)."),
    destroyedExplosion: z
      .object({
        radius: z.number().finite().nonnegative().optional().describe("Distance in meters at which the wreck's explosion damage reaches its minimum."),
        effectiveRadius: z.number().finite().nonnegative().optional().describe("Distance in meters within which the wreck's explosion does full damage."),
        falloff: z.number().finite().optional().describe("How fast the explosion's damage falls with distance, as stored."),
      })
      .optional()
      .describe("The explosion when the vehicle is destroyed."),
    mass: z.number().finite().positive().optional().describe("Mass of the vehicle body as the game's physics stores it (kg). Wheeled vehicles and helicopters only: tracked vehicles store no body mass in their files (no mass override in the blueprint's body; the track and sprocket masses are in `tracks`), so none is published."),
    engine: z
      .object({
        torqueCurve: z.array(z.object({ rpm: z.number().finite().describe("Engine speed of this key."), torque: z.number().finite().describe("Torque at that speed, as stored.") })).describe("Engine torque by engine speed, as the keys of the game's curve (rpm and torque as stored, sorted by rpm). The game interpolates between keys."),
        torqueScale: z.number().finite().optional().describe("Multiplier on the curve's torque. Absent when the game leaves it at its default."),
        frictionTorque: z.number().finite().optional().describe("Engine braking torque, as stored. Absent when the game leaves it at its default."),
        idleRpm: z.number().finite().optional().describe("Idle speed. Absent when the game leaves it at its default."),
        limitRpm: z.number().finite().optional().describe("Rev limiter speed. Absent when the game leaves it at its default."),
        inertia: z.number().finite().optional().describe("Engine inertia, as stored."),
        boostScale: z.number().finite().optional().describe("Torque multiplier while boosting, as stored."),
        extraPowerRatio: z.number().finite().optional().describe("Extra power multiplier of a tracked vehicle's engine, as stored."),
      })
      .optional()
      .describe("Engine of a wheeled or tracked vehicle. Helicopters have no engine curve in the data read."),
    transmission: z
      .object({
        gearRatios: z.array(z.number().finite()).describe("Gear ratios in the order the game stores them. A wheeled vehicle's last entry is reverse; tracked vehicles list some entries the game does not document, so read them with care."),
        finalGearRatio: z.number().finite().optional().describe("Final drive ratio (a tracked vehicle's differential ratio)."),
        changeTime: z.number().finite().optional().describe("Time a gear change takes, as stored."),
        clutchTime: z.number().finite().optional().describe("Clutch engagement time, as stored."),
        gearUpRatio: z.number().finite().optional().describe("Engine load at which an automatic gearbox shifts up, as stored."),
        gearDownRatio: z.number().finite().optional().describe("Engine load at which an automatic gearbox shifts down, as stored."),
      })
      .optional()
      .describe("Gearbox of a wheeled or tracked vehicle."),
    tracks: z
      .object({
        trackMass: z.number().finite().optional().describe("Mass of the track, as stored. Absent when the game leaves it at its default."),
        sprocketMass: z.number().finite().optional().describe("Mass of a drive sprocket, as stored. Absent when the game leaves it at its default."),
      })
      .optional()
      .describe("Masses of a tracked vehicle's track parts, when the game sets them."),
  })
  .describe("One vehicle variant.");
export type Vehicle = z.infer<typeof Vehicle>;

export const VehiclesFile = z.object({ ...header, vehicles: z.array(Vehicle).describe("One entry per vehicle variant, sorted by id.") }).describe("Vehicle statistics as the game shows them in the vehicle shop. Ids are vehicle items in items.json.");
export type VehiclesFile = z.infer<typeof VehiclesFile>;

export const DamageRule = z
  .object({
    entity: z.string().min(1).describe("What the rule belongs to: the damageable entity the game's table row names, such as `Infantry`, `Armor`, `Helmet`, `Armor.Ghillie`, `Vehicle` or one vehicle (`Vehicle.Air.Rotary.Havoc`). The `Meta.Damage.` prefix is dropped."),
    source: z.array(z.string()).describe("Tags the incoming damage must carry for the rule to apply, such as `Bullet`, `Bullet.556mm`, `Bullet.AmmoModifier.HollowPoint` or `Explosive.Rocket.84mm`. All of them must match. Empty means any damage."),
    target: z.array(z.string()).describe("Tags the target must carry, such as `Armor`, `Helmet.SuperHeavy`. Empty means any target."),
    instigator: z.array(z.string()).describe("Tags the attacker must carry. Empty means any attacker."),
    hitLocations: z.array(z.string()).describe("Hit locations the rule is limited to (`Vehicle.MainRotor`, `Infantry.Head`), or attribute tags for vehicle parts. Empty means anywhere."),
    alignment: z.string().optional().describe("`Friendly` for rules that only apply to damage between teammates. Absent otherwise."),
    category: z.string().min(1).describe("The group the game applies the rule in, such as `Weapon`, `Calibre`, `AmmoModifier`, `Armor`, `Bone`, `Penetration`. Rules of one category do not stack the way different categories do."),
    operation: z.string().min(1).describe("How the amount changes the damage. `Percentage_Ongoing` reads as a percentage change to the running damage: -20 is 20% less and 100 doubles it. `Add` adds a flat amount of damage (tracked vehicles crushing buildables). The game's own code decides the exact order rules apply in."),
    amount: z.number().finite().describe("The amount: a percentage for `Percentage_Ongoing`, damage points for `Add`."),
    custom: z.string().optional().describe("Name of the game's own code that computes the real effect when the rule is not a plain percentage (for example `B_BoneDamageModifiers_C`, which applies the hit-location multipliers). Absent for plain rules."),
  })
  .describe("One rule in the game's damage model. Rules that do nothing are left out.");
export type DamageRule = z.infer<typeof DamageRule>;

export const HitLocationMultipliers = z
  .object({
    weaponClass: z.string().min(1).describe("`Universal`, or the weapon class the multipliers are for, such as `Weapon.AR`, `Weapon.Sniper`. The `Meta.Damage.` prefix is dropped."),
    multipliers: z.record(z.string(), z.number().finite()).describe("Damage multiplier per hit location, keyed by location (`Head`, `Neck`, `Torso.Upper`, ...)."),
  })
  .describe("Damage multiplier by body part for one weapon class.");
export type HitLocationMultipliers = z.infer<typeof HitLocationMultipliers>;

export const AmmoTypeEffectiveness = z
  .object({
    ammoType: z.string().min(1).describe("Ammo type: `FMJ`, `HollowPoint`, `ArmorPiercing`, with `.Tracer` variants."),
    modifier: z.number().finite().describe("Penetration effectiveness multiplier of the ammo type."),
    byArmsClass: z.record(z.string(), z.number().finite()).describe("Multiplier by weapon arms class (`Small`, `Medium`, `High`, `Special`) that replaces `modifier` for that class. Empty when the game gives none."),
  })
  .describe("How well an ammo type penetrates armor.");
export type AmmoTypeEffectiveness = z.infer<typeof AmmoTypeEffectiveness>;

export const VehicleSeatProtection = z
  .object({
    vehicle: z.string().min(1).describe("Vehicle variant id from items.json."),
    rules: z
      .array(
        z.object({
          damageSources: z.array(z.string()).describe("Arms classes the reduction applies to (`Small`, `Medium`, `High`, `Special`)."),
          reduction: z.number().finite().describe("Percent change to damage the occupant takes; -90 is 90% less."),
        }),
      )
      .describe("Damage reduction for a person sitting in the vehicle, by arms class."),
  })
  .describe("How much a vehicle protects its occupants.");
export type VehicleSeatProtection = z.infer<typeof VehicleSeatProtection>;

export const DamageFile = z
  .object({
    ...header,
    rules: z.array(DamageRule).describe("The damage rules, grouped by entity in the game's order. Order inside an entity matters to the game."),
    hitLocationMultipliers: z.array(HitLocationMultipliers).describe("Body-part multipliers by weapon class."),
    ammoTypes: z.array(AmmoTypeEffectiveness).describe("Penetration effectiveness by ammo type."),
    vehicleSeats: z.array(VehicleSeatProtection).describe("Occupant protection by vehicle."),
  })
  .describe("The game's damage model: percentage rules by source, target and hit location (ammo types, calibers, armor, vehicles), body-part multipliers by weapon class, ammo-type penetration, and occupant protection in vehicles. Base damage per hit is in ammo.json; this file says what happens to it.");
export type DamageFile = z.infer<typeof DamageFile>;

export const Armor = z
  .object({
    id: z.string().min(1).describe("Item id from items.json."),
    name: z.string().optional().describe("Display name, as in items.json (the game's UI table). Absent when the game has none."),
    slot: z.string().min(1).describe("Equipment slot: `Armor` (body) or `Helmet`."),
    damageContext: z.string().min(1).describe("The target tag damage rules use for this piece, such as `Armor.Heavy` or `Helmet.SuperHeavy` (see `target` in damage.json). The `Meta.Damage.` prefix is dropped."),
    coveredLocations: z.array(z.string()).describe("Body parts the piece protects, such as `Torso.Upper` or `Head`."),
    durability: z.number().finite().positive().optional().describe("Hit points of the armor before it is spent."),
    stages: z
      .array(
        z.object({
          damageReduction: z.number().finite().describe("Percent of damage the armor absorbs at this stage."),
          thickness: z.number().finite().describe("Plate thickness at this stage, as stored."),
          density: z.number().finite().describe("Plate density at this stage, as stored."),
        }),
      )
      .describe("How protection changes as the armor wears down, from new to nearly spent."),
    modifiers: z.array(Modifier).describe("Changes the piece makes to the wearer's attributes (speed, stamina and so on). Plain numbers only."),
  })
  .describe("One armor or helmet item.");
export type Armor = z.infer<typeof Armor>;

export const WeightClass = z
  .object({
    name: z.string().min(1).describe("Weight class: `Lightest`, `Light`, `Medium`, `Heavy`, `SuperHeavy`."),
    minWeightKg: z.number().finite().nonnegative().describe("Carried weight in kilograms from which the class applies."),
    modifiers: z.array(Modifier).describe("Changes to the player while in this class (speed, jump, stamina regeneration, aim sway, aim time)."),
  })
  .describe("A tier of carried weight and what it does to the player.");
export type WeightClass = z.infer<typeof WeightClass>;

export const EquipmentFile = z
  .object({
    ...header,
    armor: z.array(Armor).describe("Armor and helmets, sorted by item id."),
    weightClasses: z.array(WeightClass).describe("Carried-weight tiers, lightest first. Item weights are in items.json."),
  })
  .describe("Worn protection and the effect of carried weight.");
export type EquipmentFile = z.infer<typeof EquipmentFile>;

export const SkillEffect = z
  .object({
    trigger: z.string().min(1).describe("When the effect applies, the game's skill trigger without its `Meta.Skill.` prefix (`Character`, `Character.HeldItemUpdated`, ...)."),
    effect: z.string().min(1).describe("Name of the game's gameplay effect the skill applies. For skills that only unlock an ability this is the whole effect."),
    attribute: z.string().optional().describe("Attribute the skill level scales, such as `Movement.ReadyToFirePlayRate`. Absent when the effect has no level-scaled value."),
    curve: z.string().optional().describe("Name of the game's curve the values come from."),
    levels: z
      .array(z.object({ level: z.number().finite().describe("Skill level."), value: z.number().finite().describe("Value of the attribute at that level (a multiplier unless the attribute says otherwise).") }))
      .optional()
      .describe("Value by skill level, from the curve. The game interpolates linearly between points."),
  })
  .describe("One effect of a skill.");
export type SkillEffect = z.infer<typeof SkillEffect>;

export const SkillLayout = z
  .object({
    row: z.number().int().nonnegative().describe("Ring of the tree, 0 for the innermost. Rings are farther from the center as the number grows (checked against the canvas positions)."),
    column: z.number().int().nonnegative().describe("Position around the ring, counted from 0."),
    x: Num.describe("Horizontal canvas position of the node in the game's skill tree widget."),
    y: Num.describe("Vertical canvas position of the node in the game's skill tree widget."),
  })
  .describe("Where the skill sits in its role's tree.");
export type SkillLayout = z.infer<typeof SkillLayout>;

export const Skill = z
  .object({
    id: z.string().min(1).describe("Skill id: the game's skill tag without the `Meta.Role.` prefix, for example `Infantry.SprintBreach`."),
    role: z.string().min(1).describe("The role whose tree holds the skill: Infantry, Support, Medic, Recon, Pilot or Driver."),
    name: z.string().optional().describe("Name shown in the skill tree."),
    description: z.string().optional().describe("Description shown in the skill tree."),
    layout: SkillLayout.optional().describe("Position in the role's tree. Absent for a skill the game does not place in the tree."),
    effects: z.array(SkillEffect).describe("What the skill does. Empty when the client files hold the skill's text and place in the tree but no effect data (the effects are applied by the server or by code)."),
  })
  .describe("One role skill.");
export type Skill = z.infer<typeof Skill>;

export const SkillTree = z
  .object({
    role: z.string().min(1).describe("Role id."),
    rows: z.number().int().positive().describe("Number of rings in the role's tree grid."),
    columns: z.number().int().positive().describe("Number of positions around each ring."),
    shape: z.string().min(1).describe("The game's grid type: `Circle` (a half circle, drawn from the start angle over a total angle of 180 degrees)."),
  })
  .describe("The grid a role's skills are placed on.");
export type SkillTree = z.infer<typeof SkillTree>;

export const SkillsFile = z
  .object({ ...header, trees: z.array(SkillTree).describe("The skill tree grid of each role, sorted by role."), skills: z.array(Skill).describe("Role skills, sorted by id.") })
  .describe("Role skills: names, descriptions, place in the role's tree and the value of each effect by skill level. Item unlocks by role and level are in items.json. Skill point costs and prerequisites are not in the client files.");
export type SkillsFile = z.infer<typeof SkillsFile>;

export const RoleLevel = z
  .object({
    level: z.number().int().nonnegative().describe("Role level."),
    xp: z.number().finite().nonnegative().describe("Total role XP needed to reach this level, counted from zero (level 0 needs 0). The game's progress display reads `current XP / next level XP`, so the values are totals, not per-level costs."),
  })
  .describe("One level of a role.");
export type RoleLevel = z.infer<typeof RoleLevel>;

export const Role = z
  .object({
    id: z.string().min(1).describe("Role id: the game's role tag without the `Meta.Role.` prefix: Infantry, Support, Medic, Recon, Pilot or Driver. The same ids as `unlock.role` in items.json."),
    xpResource: z.string().min(1).describe("The game's attribute that holds the role's XP, without the `Attribute.Meta.` prefix, for example `XP.Role.Infantry`."),
    levels: z.array(RoleLevel).describe("Every level from 0 up, sorted by level."),
  })
  .describe("The XP a role needs for each level.");
export type Role = z.infer<typeof Role>;

export const RolesFile = z
  .object({ ...header, roles: z.array(Role).describe("Roles, sorted by id.") })
  .describe("Role mastery: the XP needed for each level of each role. Items unlock at a role level (`unlock` in items.json), so this turns a level gate into an amount of XP. The overall Wardog (career) level, which gates some items up to level 150, has no table of its own: the game's text says all role levels combine into it, without giving the formula.");
export type RolesFile = z.infer<typeof RolesFile>;

export const Reward = z
  .object({
    action: z.string().min(1).describe("What earns the reward, from the game's table name: `PlayerKill`, `Heal`, `Revive`, `VehicleDestroyed`, `Repair`, `Refuel`, `Spotting`, `ControlZoneReward`, ..."),
    context: z.string().min(1).describe("The case within the action, the game's context tag without its `Meta.Progression.Context.` prefix (a vehicle variant id for vehicle-specific rewards)."),
    description: z.string().optional().describe("The game's own note on when the case applies."),
    resource: z.string().min(1).describe("What is paid: `Cash`."),
    base: z.number().finite().describe("Base amount."),
    modifiers: z.record(z.string(), z.number().finite()).describe("The other numbers of the row, named as the game names them (`FriendlyModifier`, `ModifierCZ` for control zones, `ModifierHZ` for hot zones, `AssistBaseModifier`, ...). They scale or adjust the base amount depending on who and where."),
  })
  .describe("One cash reward case.");
export type Reward = z.infer<typeof Reward>;

export const RewardsFile = z
  .object({ ...header, rewards: z.array(Reward).describe("Reward cases, sorted by action then by the order of the game's table.") })
  .describe("Cash rewards for in-game actions (kills, heals, revives, repairs, building, objectives) with their base amounts and modifiers. The game also has a challenge reward system (challenge-rewards.json) with its own formulas and different numbers (a player kill has a base of 250 here and 300 there); the files do not say which one the live game pays by.");
export type RewardsFile = z.infer<typeof RewardsFile>;

export const RewardCondition = z
  .object({
    match: z.enum(["all", "any", "none"]).describe("How the parts combine: `all` of them, `any` of them, or `none` of them."),
    tags: z.array(z.string()).optional().describe("Context tags tested directly (for example `Challenges.Context.Headshot`). `all` needs every tag, `any` needs at least one, `none` needs none of them. Present when the condition tests tags."),
    of: z
      .array(z.object({ match: z.enum(["all", "any", "none"]).describe("How this part combines its tags."), tags: z.array(z.string()).describe("Context tags tested by this part.") }).describe("A group of context tags."))
      .optional()
      .describe("Groups of tags that are combined with `match`. Present when the condition combines several groups, such as `all` of (`any` of A and B) and (`none` of C)."),
  })
  .describe("A test on the tags that describe what just happened (a headshot, a friendly kill, the player standing in a hot zone). It is the game's gameplay tag query, decoded.");
export type RewardCondition = z.infer<typeof RewardCondition>;

export const RewardVariable = z
  .discriminatedUnion("type", [
    z.object({ name: z.string().min(1).describe("Variable name."), type: z.literal("literal").describe("A fixed number."), value: Num.describe("The number.") }).describe("A fixed number."),
    z
      .object({ name: z.string().min(1).describe("Variable name."), type: z.literal("game").describe("A number the game supplies while it plays."), game: z.string().min(1).describe("The name of the game value, for example `KillStreak`, `LastVictimCount`, `CrewCount`, `BuildProgress` or `BaseRewardValue`.") })
      .describe("A number the game fills in at the moment the reward is paid."),
    z
      .object({
        name: z.string().min(1).describe("Variable name."),
        type: z.literal("scaling").describe("A number looked up on a curve."),
        input: z.string().min(1).describe("The game value that is looked up on the curve, for example `DistanceToTarget` or `DamageFraction`."),
        curve: z.string().min(1).describe("Id of the curve in `curves`."),
      })
      .describe("A number read from a curve at the value of `input`."),
  ])
  .describe("A named number used by a reward formula.");
export type RewardVariable = z.infer<typeof RewardVariable>;

export const RewardInput = z
  .object({
    name: z.string().min(1).describe("The name the formula uses."),
    default: z.string().min(1).describe("The variable the name stands for when no option applies."),
    options: z
      .array(z.object({ when: RewardCondition, use: z.string().min(1).describe("The variable the name stands for when `when` holds.") }).describe("One choice."))
      .describe("Choices tried in order: the first whose `when` holds decides which variable the name stands for."),
  })
  .describe("A formula name whose value depends on the situation. The first matching option wins, else the default.");
export type RewardInput = z.infer<typeof RewardInput>;

export const RewardResource = z
  .object({
    resource: z.string().min(1).describe("What is paid, without the `Attribute.Meta.` prefix: `Currency.Cash`, or role XP as `XP.Role` (the game decides which role it goes to) or `XP.Role.<Role>` for one role."),
    formula: z.string().min(1).describe("The amount, as the game's formula. Functions: clamp(value, min, max), pow(base, exponent), max(a, b). Each name is an entry of `inputs` or a variable."),
    inputs: z.array(RewardInput).describe("Names in the formula that depend on the situation. Names not listed here are variables."),
    variables: z.array(RewardVariable).describe("The numbers the formula and the inputs use."),
  })
  .describe("One payment of a reward.");
export type RewardResource = z.infer<typeof RewardResource>;

export const ChallengeReward = z
  .object({
    id: z.string().min(1).describe("The game's reward tag without the `Challenges.Rewards.` prefix, for example `PlayerKill`, `PlayerKill.CrewAssist` or `Spotting.Added.Kodiak`."),
    resources: z.array(RewardResource).describe("What the reward pays: cash, usually together with role XP."),
  })
  .describe("What the game pays for one kind of event.");
export type ChallengeReward = z.infer<typeof ChallengeReward>;

export const RewardCurve = z
  .object({
    id: z.string().min(1).describe("The game's tag for the curve, for example `LiveCurves.Challenges.SessionEvents.PlayerKill.DistanceScalar`."),
    points: z
      .array(
        z
          .object({
            input: Num.describe("The value being looked up, in the game's units (distances are as stored by the game, not converted)."),
            value: Num.describe("The curve's value from this input on."),
            interpolation: z.enum(["constant", "linear", "cubic"]).describe("How the curve moves from this point to the next: `constant` holds the value until the next input (a step)."),
          })
          .describe("One point of the curve."),
      )
      .describe("Points in the order the game stores them (rising input)."),
  })
  .describe("A curve that scales a reward.");
export type RewardCurve = z.infer<typeof RewardCurve>;

export const RewardEvent = z
  .object({
    id: z.string().min(1).describe("Event id: the game's event tag without the `Challenges.SessionEvents.` prefix, for example `PlayerKill.Assist`."),
    name: z.string().min(1).describe("The game's name for the event."),
    description: z.string().optional().describe("The game's note on when the event pays, when it has one."),
  })
  .describe("An in-match event that can pay a reward.");
export type RewardEvent = z.infer<typeof RewardEvent>;

export const ChallengeRewardsFile = z
  .object({
    ...header,
    events: z.array(RewardEvent).describe("The game's definitions of the in-match events, sorted by id. A reward id (`Challenges.Rewards.` prefix removed) equals an event id only for some events: the game pays most events through several reward rows (one per vehicle, item or building), and which rows an event uses is in the game's logic, not in these tables."),
    rewards: z.array(ChallengeReward).describe("Rewards, sorted by id."),
    curves: z.array(RewardCurve).describe("Curves the rewards use, sorted by id."),
  })
  .describe("How much cash and role XP each in-match event pays, as the game's own formulas: the formula, the numbers behind its names, the situations that change them, and the curves that scale them. The game can change these values from its server ('live curves' and the challenge reward registry have a server source), so a live game may differ from the files.");
export type ChallengeRewardsFile = z.infer<typeof ChallengeRewardsFile>;

export const Buildable = z
  .object({
    id: z.string().min(1).describe("The game's buildable id, for example `Id.Buildable.Bunker`."),
    name: z.string().optional().describe("Display name."),
    icon: z.string().optional().describe("Path of the buildable's icon inside `assets/icons/` (the same folder as the item icons). Absent when the game has no icon for it."),
    cost: z.number().finite().nonnegative().describe("Building supplies it costs to place."),
    maxHealth: z.number().finite().positive().describe("Hit points when fully built."),
    repairSpeedMultiplier: z.number().finite().optional().describe("How fast it repairs compared with the standard rate, when the game states one."),
    maxStack: z.number().int().positive().optional().describe("How many can be carried or placed as a stack, when the game states one."),
    damageEntity: z.string().optional().describe("The `entity` of its rules in damage.json, such as `Buildable.Bunker`."),
    size: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).optional().describe("Size of the finished stage's bounding box as the game stores it: [x, y, z] in meters. Structures built in several pieces (a bunker with a floor and a roof) have a separate entry per piece."),
    tools: z.array(z.string()).describe("Build tools that offer it (`SmallHammer`, `MediumHammer`, `LargeHammer`)."),
    placementRules: z.array(z.string()).describe("Names of the placement conditions the game checks, such as `WithinFobBounds` or `SafeZone` (no building in a safe zone)."),
  })
  .describe("One buildable structure.");
export type Buildable = z.infer<typeof Buildable>;

export const BuildablesFile = z
  .object({ ...header, units: z.literal("meters").describe("Unit of every distance in the file."), buildables: z.array(Buildable).describe("Buildables, sorted by id.") })
  .describe("Structures players can build (fortifications, FOB parts, stations): cost, health, size, where they can be placed and how they take damage.");
export type BuildablesFile = z.infer<typeof BuildablesFile>;

export const LootItem = z
  .object({
    item: z.string().min(1).describe("Item id from items.json."),
    amount: z.number().int().positive().describe("Units spawned."),
    weight: z.number().finite().nonnegative().describe("Relative chance this entry is picked among the table's entries."),
    subItems: z
      .array(
        z.object({
          item: z.string().min(1).describe("Item id from items.json."),
          chance: z.number().finite().describe("Percent chance it spawns with the main item."),
          amount: z.number().int().positive().describe("Units spawned."),
        }),
      )
      .describe("Items that spawn together with this one (attachments, magazines, grenades)."),
  })
  .describe("One entry of a loot table.");
export type LootItem = z.infer<typeof LootItem>;

export const LootTable = z
  .object({
    id: z.string().min(1).describe("Loot table id: the game's tag without its `Lootable.` prefix, such as `Tower` or `AbandonedTower`."),
    spawnChance: z.number().finite().describe("Percent chance the loot spawns."),
    spawnByDefault: z.boolean().optional().describe("True when it spawns at the start of a match."),
    spawnByPoints: z.boolean().optional().describe("True when spawning is paced by spawn points."),
    initialSpawnTime: z.number().finite().optional().describe("Seconds into the match before the first spawn."),
    initialSpawnPoints: z.number().finite().optional().describe("Spawn points available at the start."),
    canRespawn: z.boolean().optional().describe("True when the loot comes back after it is taken."),
    respawnTime: z.number().finite().optional().describe("Seconds until it respawns, as stored."),
    neverSelectPreviousItem: z.boolean().optional().describe("True when a respawn never repeats the previous item."),
    spawnInsideControlZoneOnly: z.boolean().optional().describe("True when it only spawns inside the control zone."),
    items: z.array(LootItem).describe("What can spawn."),
  })
  .describe("One loot table.");
export type LootTable = z.infer<typeof LootTable>;

export const LootFile = z
  .object({ ...header, tables: z.array(LootTable).describe("Loot tables, sorted by id.") })
  .describe("What spawns as loot (in towers and other lootables): items, amounts, weights and respawn rules.");
export type LootFile = z.infer<typeof LootFile>;

export const Cosmetic = z
  .object({
    id: z.string().min(1).describe("Cosmetic id: the game's tag without its `Meta.Cosmetic.` prefix, for example `BlackAndGold.AK74`."),
    item: z.string().min(1).describe("What it applies to: an item id from items.json, or an emote id (`Id.Emote.*`), or a vehicle variant for taxi liveries."),
    set: z.string().min(1).describe("The cosmetic set or category it belongs to (`BlackAndGold`, `Emote`, `FactionLogo`, `Taxi`)."),
    archetype: z.string().optional().describe("Weapon archetype it is for, such as `AR` or `Pistol`. Absent for emotes."),
    source: z.string().min(1).describe("The game's table the cosmetic was read from, for example `Season01_Skins`."),
  })
  .describe("One cosmetic: a weapon skin, emote, faction logo or taxi livery.");
export type Cosmetic = z.infer<typeof Cosmetic>;

export const CosmeticSet = z
  .object({
    id: z.string().min(1).describe("Set id, as used by `set` in a cosmetic."),
    name: z.string().min(1).describe("Display name."),
    sortIndex: z.number().int().describe("Order in the collection screen."),
    hidden: z.boolean().describe("True when the set is hidden in the collection screen."),
  })
  .describe("A named group of cosmetics.");
export type CosmeticSet = z.infer<typeof CosmeticSet>;

export const CosmeticsFile = z
  .object({ ...header, sets: z.array(CosmeticSet).describe("Named sets, in collection order."), cosmetics: z.array(Cosmetic).describe("Cosmetics, sorted by id.") })
  .describe("The cosmetic catalog: skin sets and what each cosmetic applies to. Prices and availability are not in the game files read.");
export type CosmeticsFile = z.infer<typeof CosmeticsFile>;

export const TagText = z
  .object({
    tag: z.string().min(1).describe("The game's gameplay tag, as it appears in the other files (item tags, weapon archetypes, calibers, damage types, roles, slots)."),
    text: z.string().min(1).describe("The text the game shows for the tag."),
    source: z.string().min(1).describe("The game's table the text comes from, for example `Archetypes`, `Calibers` or `Roles`."),
  })
  .describe("One tag with its display text.");
export type TagText = z.infer<typeof TagText>;

export const TagsFile = z
  .object({ ...header, tags: z.array(TagText).describe("Tags with text, sorted by tag then source. A tag can appear under more than one source with different text.") })
  .describe("Display text for the game's gameplay tags, to turn tags such as `Item.Archetype.AR` into words. Only tags with text are listed.");
export type TagsFile = z.infer<typeof TagsFile>;

export const Stance = z
  .object({
    name: z.string().min(1).describe("`Stand`, `Crouch` or `Prone`."),
    capsuleHalfHeight: z.number().finite().positive().describe("Half the height of the player's collision capsule, in meters."),
    capsuleRadius: z.number().finite().positive().describe("Radius of the player's collision capsule, in meters."),
    eyeHeight: z.number().finite().positive().describe("Height of the camera above the ground, in meters."),
    staminaCost: z.number().finite().nonnegative().describe("Stamina it costs to change into this stance, as stored."),
    maxSpeedMultiplier: z.number().finite().optional().describe("Multiplier on the player's top speed while in this stance. Absent when the game gives the stance no explicit multiplier."),
  })
  .describe("One stance.");
export type Stance = z.infer<typeof Stance>;

export const MovementFile = z
  .object({
    ...header,
    units: z.literal("meters").describe("Unit of every distance in the file. Speeds are meters per second."),
    stances: z.array(Stance).describe("Stand, crouch and prone, in that order."),
    stanceTransitions: z
      .array(z.object({ from: z.string().min(1).describe("Stance changed from."), to: z.string().min(1).describe("Stance changed to."), seconds: z.number().finite().nonnegative().describe("How long the change takes.") }))
      .describe("How long each stance change takes."),
    ground: z
      .object({
        minSpeed: z.number().finite().nonnegative().optional().describe("The game's `MinSpeed`, in meters per second."),
        backMaxSpeedScale: z.number().finite().optional().describe("Multiplier on top speed when moving backward."),
        strafeMaxSpeedScale: z.number().finite().optional().describe("Multiplier on top speed when moving sideways."),
        forwardStrafeScale: z.number().finite().optional().describe("Multiplier when moving forward and sideways at once, as stored."),
        forwardStrafeScaleSprinting: z.number().finite().optional().describe("The same while sprinting, as stored."),
        slowWalk: z.record(z.string(), z.number().finite()).describe("The slow-walk settings and the fraction of speed each gives, by name (`Slow`, `Moderate`, `Fast`)."),
        leanTime: z.number().finite().optional().describe("Seconds to lean out."),
        unleanTime: z.number().finite().optional().describe("Seconds to come back from a lean."),
        blockSprintTime: z.number().finite().optional().describe("Seconds sprinting is blocked after being interrupted, as stored."),
        blockTacticalSprintTime: z.number().finite().optional().describe("Seconds tactical sprinting is blocked after being interrupted, as stored."),
        minStartTacticalSprint: z.number().finite().optional().describe("Fraction of stamina needed to start a tactical sprint, as stored."),
      })
      .describe("Walking and running."),
    jump: z
      .object({
        velocity: z.number().finite().positive().optional().describe("Upward speed of a jump, in meters per second."),
        maxStamina: z.number().finite().optional().describe("Jump stamina pool, as stored."),
        staminaCost: z.number().finite().optional().describe("Stamina one jump costs, as stored."),
        staminaRegenPerSecond: z.number().finite().optional().describe("Jump stamina regained per second, as stored."),
        cooldown: z.number().finite().optional().describe("Seconds between jumps."),
      })
      .describe("Jumping."),
    falling: z
      .object({
        maxSpeed: z.number().finite().optional().describe("Top horizontal speed in the air, in meters per second."),
        airControl: z.number().finite().optional().describe("Fraction of ground control the player has in the air, as stored."),
        terminalSpeed: z.number().finite().optional().describe("Fastest fall speed, in meters per second."),
        landingDamage: z
          .array(z.object({ speed: z.number().finite().describe("Landing speed in meters per second."), damage: z.number().finite().describe("Damage taken at that speed.") }))
          .describe("Fall damage by landing speed: no damage below the first point, rising linearly between points. The curve's x axis is in the game's speed unit (centimeters per second) and is published in meters per second."),
      })
      .describe("Falling."),
    ladder: z
      .object({
        climbUpMaxSpeed: z.number().finite().optional().describe("Fastest climb up, in meters per second."),
        climbDownMaxSpeed: z.number().finite().optional().describe("Fastest climb down, in meters per second."),
        slideDownSpeed: z.number().finite().optional().describe("Speed of sliding down a ladder, in meters per second."),
      })
      .describe("Ladders."),
    bodyDragging: z
      .object({
        backMaxSpeedScale: z.number().finite().optional().describe("Multiplier on top speed when moving backward while dragging a body."),
        strafeMaxSpeedScale: z.number().finite().optional().describe("Multiplier on top speed when moving sideways while dragging a body."),
        forwardStrafeScale: z.number().finite().optional().describe("Multiplier when moving forward and sideways at once while dragging a body, as stored."),
        backwardStrafeScale: z.number().finite().optional().describe("Multiplier when moving backward and sideways at once while dragging a body, as stored."),
      })
      .describe("The same scales while dragging a body."),
    stamina: z
      .object({
        regenPerSecond: z.number().finite().optional().describe("Stamina regained per second, as stored."),
        regenDelay: z.number().finite().optional().describe("Seconds before regeneration starts."),
        depletedRegenDelay: z.number().finite().optional().describe("Seconds before regeneration starts after the stamina ran out."),
        stanceRegenPerSecond: z.number().finite().optional().describe("Stamina regained per second by the stance stamina pool, as stored."),
        stanceRegenDelay: z.number().finite().optional().describe("Seconds before the stance pool regenerates."),
        stanceCooldown: z.number().finite().optional().describe("Seconds between stance changes."),
      })
      .describe("Stamina regeneration. The base pool size and the sprint cost are not in the files the client holds."),
    slopes: z.object({ maxWalkableAngle: z.number().finite().optional().describe("Steepest slope that can be walked, in degrees.") }).describe("Slopes."),
    friction: z.number().finite().optional().describe("The game's ground friction, as stored."),
    swimming: z
      .object({
        waterAcceleration: z.number().finite().optional().describe("Acceleration in water, in meters per second squared."),
        inputDeceleration: z.number().finite().optional().describe("Deceleration without input in water, in meters per second squared."),
      })
      .describe("Swimming."),
    vaulting: z
      .object({
        vaultDistance: z.number().finite().optional().describe("Farthest obstacle distance for a vault, in meters."),
        baseTraversalSpeed: z.number().finite().optional().describe("Speed of the vault, in meters per second."),
      })
      .describe("Vaulting over low obstacles."),
    mantling: z
      .object({
        maxHeightAboveLedge: z.number().finite().optional().describe("Highest the ledge may be above the player's reach to scale over, in meters."),
        forwardOnlyHeight: z.number().finite().optional().describe("Highest ledge that can be mantled when moving straight forward, in meters."),
        maxTargetFloorHeight: z.number().finite().optional().describe("Greatest height of the floor to land on, in meters."),
        maxWallWidth: z.number().finite().optional().describe("Widest wall that can be scaled over, in meters."),
        maxWallAngle: z.number().finite().optional().describe("Steepest wall angle, in degrees."),
        baseScaleOverSpeed: z.number().finite().optional().describe("Speed of scaling over, in meters per second."),
      })
      .describe("Mantling over ledges."),
    climbing: z
      .object({
        maxLedgeLookAngle: z.number().finite().optional().describe("Widest angle between the view and a ledge for a climb, in degrees."),
        baseTraversalSpeed: z.number().finite().optional().describe("Climbing speed, in meters per second."),
        baseScaleOverSpeed: z.number().finite().optional().describe("Speed of scaling over the top, in meters per second."),
      })
      .describe("Climbing up walls."),
    parachute: z
      .object({
        minFallHeight: z.number().finite().optional().describe("Least height above the ground to open a parachute, in meters."),
        gliderAcceleration: z.number().finite().optional().describe("Forward acceleration while gliding, in meters per second squared."),
        pullUpDragAcceleration: z.number().finite().optional().describe("Braking acceleration when pulling up, in meters per second squared."),
        pullUpStaminaPerSecond: z.number().finite().optional().describe("Stamina a pull-up uses per second, as stored."),
        pullUpStaminaRegenPerSecond: z.number().finite().optional().describe("Stamina regained per second while not pulling up, as stored."),
        minPitch: z.number().finite().optional().describe("Lowest pitch, in degrees."),
        maxPitch: z.number().finite().optional().describe("Highest pitch, in degrees."),
        maxRoll: z.number().finite().optional().describe("Largest roll, in degrees."),
      })
      .describe("Parachuting."),
  })
  .describe("How the player moves: stance sizes and speeds, jumping, falling and fall damage, ladders, body dragging, stamina regeneration and the traversal moves. The base top speed is not in the client files (the data holds only multipliers of it), so speeds are given as multipliers.");
export type MovementFile = z.infer<typeof MovementFile>;

export type PropertyValue = string | number | boolean | null | PropertyValue[] | { [key: string]: PropertyValue };
const PropertyValue: z.ZodType<PropertyValue> = z.lazy(() => z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(PropertyValue), z.record(z.string(), PropertyValue)]));

export const VehicleConfigExport = z
  .object({
    name: z.string().min(1).describe("The export's name inside its package."),
    type: z.string().min(1).describe("The export's class, as the game names it (`MWheeledVehicleCharacteristicsDataAsset`, `CurveFloat`)."),
    outer: z.string().optional().describe("Name of the export this one is embedded in, when it is not the package's own object."),
    properties: z.record(z.string(), PropertyValue).describe("Every property the game stores for it, under the game's own names. Values are stored units (centimeters, degrees, milliseconds as the game keeps them). A reference to another object is `{ ref, object? }` (see `assets[].package`), a gameplay tag is `{ tag }`, text is `{ text, table?, key? }` with the string table entry it comes from. Properties the game leaves at their default are not in its files and are absent."),
  })
  .describe("One object of a vehicle asset package.");
export type VehicleConfigExport = z.infer<typeof VehicleConfigExport>;

export const VehicleConfigAsset = z
  .object({
    package: z.string().min(1).describe("The game's package path (`/WHL_05/Data/DA_Characteristics_WHL_05_Humvee`), which is what a `ref` in a property names."),
    asset: z.string().min(1).describe("Path of the asset inside the game files."),
    exports: z.array(VehicleConfigExport).describe("The package's objects, in the game's order."),
  })
  .describe("One asset reachable from a vehicle config.");
export type VehicleConfigAsset = z.infer<typeof VehicleConfigAsset>;

export const VehicleConfig = z
  .object({
    package: z.string().min(1).describe("Package path of the config asset, also its entry in `assets`."),
    type: z.string().min(1).describe("Config class: `MWheeledVehicleConfigDataAsset`, `MTrackedVehicleConfigDataAsset`, `BHRotaryVehicleConfigDataAsset` or `BHAirplaneVehicleConfigDataAsset` or `BHBaseVehicleConfigDataAsset` (stationary weapons and drones)."),
    family: z.enum(["wheeled", "tracked", "rotary", "airplane", "stationary"]).describe("Vehicle family, from the config class."),
    damageEntity: z.string().optional().describe("The `entity` of the vehicle's damage rules in damage.json, from the config's gameplay systems asset."),
    variants: z.array(z.string()).describe("Vehicle variants (ids from vehicles.json) of the same family that share this config's damage entity. A platform with several configs lists its variants under each; empty for configs of things the shop does not sell."),
    assets: z.array(z.string()).describe("Package paths of every asset reachable from the config by following its references (the config itself included), sorted. Each is an entry in `assets`."),
  })
  .describe("One vehicle config and the assets it links to.");
export type VehicleConfig = z.infer<typeof VehicleConfig>;

export const VehicleConfigsFile = z
  .object({
    ...header,
    configs: z.array(VehicleConfig).describe("One entry per vehicle config asset, sorted by package."),
    assets: z.array(VehicleConfigAsset).describe("Every asset reachable from a config, once each, sorted by package. Shared assets (curves, a platform's characteristics used by several configs) appear once."),
    skipped: z.array(z.object({ package: z.string().min(1).describe("Package path."), types: z.array(z.string()).describe("Classes of its objects.") }).describe("A linked package left out because it is art or audio content.")).describe("Packages the configs link to that hold art or audio content rather than properties (static meshes and their collision, MetaSound audio graphs, particle systems, materials, textures). They are named here and not published. Sorted by package."),
    unresolved: z.array(z.string()).describe("Packages the configs and their assets reference that are not in the game files (or are engine classes under `/Script/`). Sorted."),
  })
  .describe("Everything the game stores about how each vehicle behaves: the config assets and the assets they link to (physics, engine, gearbox, axles, wheels, tire models, suspension, helicopter flight and drag, tracked engine and dynamics, input controls, camera spring arms, sensors, gameplay systems and effects, prediction settings, curves), with every stored property. Meant for tools that simulate or compare vehicles; `vehicles.json` has the curated numbers.");
export type VehicleConfigsFile = z.infer<typeof VehicleConfigsFile>;

export const Currency = z
  .object({
    id: z.string().min(1).describe("Currency id: the game's tag without the `Attribute.Meta.Currency.` prefix: `Cash` or `GoldBars`."),
    name: z.string().min(1).describe("Name shown in the game."),
    initialBalance: Num.nonnegative().describe("Balance a new profile starts with."),
  })
  .describe("One currency of the meta game.");
export type Currency = z.infer<typeof Currency>;

export const GoldMarketOffer = z
  .object({
    id: z.string().min(1).describe("Offer id: the game's tag without the `Meta.Cosmetic.` prefix, for example `DigitalWood.M4`. The same id as the skin or emote in cosmetics.json."),
    category: z.string().min(1).describe("The set the offer belongs to, for example `DigitalWood` or `Emote` (the `set` of the cosmetic)."),
    entity: z.string().min(1).describe("The item, vehicle variant or emote the offer is for: an `id` from items.json or vehicles.json, or the emote's id."),
    goldBars: Num.nonnegative().describe("Price in gold bars."),
    gridIndex: z.number().int().nonnegative().describe("Position of the tile in the market grid of its category."),
    tile: z.string().min(1).describe("Tile size in the market: `HERO_TILE`, `LARGE_SQUARE`, `SMALL_SQUARE` or `SMALL_RECTANGLE`."),
    expiration: z.string().min(1).describe("The game's expiration rule for the offer: `NO_EXPIRATION` or `EXPIRATION_NO_END_TIME`."),
    expirationTime: z.string().optional().describe("The time stored with the offer, UTC, when the game stores one. The game labels the offers that carry one `EXPIRATION_NO_END_TIME`, so it may be unused."),
  })
  .describe("One cosmetic offered for gold bars.");
export type GoldMarketOffer = z.infer<typeof GoldMarketOffer>;

export const PassiveChallenge = z
  .object({
    id: z.string().min(1).describe("Challenge id: the game's tag without the `Challenges.Challenge.Mission.Passive.` prefix, for example `EarnCash.3`. The number is the tier."),
    name: z.string().min(1).describe("Name shown in the game."),
    description: z.string().optional().describe("Description shown in the game; `X` stands for the target."),
    objective: z.string().min(1).describe("What is counted: the game's objective tag without the `Challenges.Objective.` prefix: `CashEarned`, `RoleXpEarned` or `TimePlayed`."),
    target: Num.positive().describe("The amount of the objective to complete the challenge. Time is in seconds. Whether the amount accumulates over the tiers or counts again for each is not stated in the data."),
    reward: z.object({ currency: z.string().min(1).describe("Currency paid, without the `Attribute.Meta.Currency.` prefix. `Intel` is not in the currency table."), amount: Num.nonnegative().describe("Amount paid.") }).describe("What completing the challenge pays."),
  })
  .describe("One tier of a passive mission.");
export type PassiveChallenge = z.infer<typeof PassiveChallenge>;

export const PassiveMission = z
  .object({
    id: z.string().min(1).describe("Mission id: the game's tag without the `Mission.Passive.` prefix: `EarnCash`, `EarnAnyRoleXp` or `TimePlayed`."),
    difficultyWeight: Num.describe("The game's difficulty weight for the mission."),
    challenges: z.array(PassiveChallenge).describe("The mission's tiers, in the game's order."),
  })
  .describe("A passive mission: a long-running goal that pays Intel at each tier.");
export type PassiveMission = z.infer<typeof PassiveMission>;

export const Achievement = z
  .object({
    id: z.string().min(1).describe("Achievement id: the game's tag without the `Achievement.` prefix, for example `Combat.LongShot`."),
    steamId: z.string().min(1).describe("The achievement's id on Steam."),
    name: z.string().min(1).describe("Name shown in the game."),
    description: z.string().optional().describe("What the achievement asks for, in the game's words. The game words only some of them."),
    thresholds: z.record(z.string(), Num).optional().describe("The numbers the game sets for the achievement's condition, by the game's parameter name, as stored: `CashThreshold` (cash), `RequiredSeconds` (seconds), `DistanceThreshold` (game units, which are centimeters). Absent for achievements with no such number."),
  })
  .describe("One achievement. The conditions themselves are in the game's logic; only the numbers they take are in the data.");
export type Achievement = z.infer<typeof Achievement>;

export const MetaFile = z
  .object({
    ...header,
    currencies: z.array(Currency).describe("Currencies, sorted by id."),
    currentSeason: z.number().int().nonnegative().describe("The season number the game files declare as current. The season definition list and the gold bar exchange rates are empty in the files."),
    goldMarket: z.array(GoldMarketOffer).describe("Cosmetics sold for gold bars, sorted by id."),
    passiveMissions: z.array(PassiveMission).describe("Passive missions, sorted by id."),
    achievements: z.array(Achievement).describe("Achievements, sorted by id."),
  })
  .describe("The meta game around matches: currencies and starting balances, the gold bar market, passive missions and achievements.");
export type MetaFile = z.infer<typeof MetaFile>;
