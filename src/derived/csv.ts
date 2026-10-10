import type { ZodType } from "zod";
import { AmmoFile, AttachmentsFile, BuildablesFile, CosmeticsFile, DamageFile, EquipmentFile, LootFile, MetaFile, ChallengeRewardsFile, RewardsFile, RolesFile, SkillsFile, TagsFile, VehiclesFile, WeaponsFile } from "../schema.gameplay.js";
import { fitsSlot } from "../lib/compatibility.js";
import { BuildingsFile, ItemsFile, ObjectivesFile, WorldObjectsFile } from "../schema.js";

type Cell = string | number | boolean | undefined;

interface Column<Row> {
  name: string;
  about: string;
  value: (row: Row) => Cell;
}

export interface CsvTable {
  /** Output path, relative to the repo root. */
  path: string;
  /** What one row is, for the data dictionary. */
  about: string;
  /** Column names with a one-line meaning, for the data dictionary. */
  columns: Array<{ name: string; about: string }>;
  content: string;
}

/** Quotes a cell when it holds a delimiter, quote or line break (RFC 4180). Absent values are empty. */
export function csvCell(value: Cell): string {
  if (value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Joins a list into one cell. The semicolon never appears in the game's ids, tags or names. */
export const list = (values: readonly string[]): string | undefined => (values.length ? values.join(";") : undefined);

/** Serializes rows with a header. Lines end with `\n`, so the output is the same on every platform. */
export function toCsv<Row>(columns: ReadonlyArray<Column<Row>>, rows: readonly Row[]): string {
  const lines = [columns.map((c) => c.name).join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvCell(c.value(row))).join(","));
  return lines.join("\n") + "\n";
}

function table<Row>(path: string, about: string, columns: ReadonlyArray<Column<Row>>, rows: readonly Row[]): CsvTable {
  return { path, about, columns: columns.map((c) => ({ name: c.name, about: c.about })), content: toCsv(columns, rows) };
}

const col = <Row>(name: string, about: string, value: (row: Row) => Cell): Column<Row> => ({ name, about, value });

/** The generated JSON files the tables are built from, by path. */
export type JsonFiles = ReadonlyMap<string, unknown>;

type Item = ItemsFile["items"][number];
type Weapon = WeaponsFile["weapons"][number];
type Projectile = AmmoFile["projectiles"][number];
type Attachment = AttachmentsFile["attachments"][number];
type Vehicle = VehiclesFile["vehicles"][number];
type Building = BuildingsFile["buildings"][number];

/** The farthest distance at which a falloff curve still multiplies damage by 1, or undefined when the weapon has no curve. */
function fullDamageRange(curve: ReadonlyArray<{ distance: number; multiplier: number }> | undefined): number | undefined {
  if (!curve?.length) return undefined;
  let last = 0;
  for (const point of curve) {
    if (point.multiplier >= 1) last = point.distance;
    else break;
  }
  return last;
}

const unitPrice = (price: number, amount: number): number => Math.round((price / amount) * 1e6) / 1e6;

/** Every CSV table, built from the generated JSON. Tables whose source file is absent are skipped. */
export function buildCsvTables(files: JsonFiles): CsvTable[] {
  const tables: CsvTable[] = [];
  const get = <T>(path: string, schema: ZodType<T>): T | undefined => (files.has(path) ? schema.parse(files.get(path)) : undefined);

  const items = get("data/items.json", ItemsFile)?.items;
  // The game compares ids without regard to case, so names are looked up that way too.
  const names = new Map((items ?? []).map((i) => [i.id.toLowerCase(), i.name]));
  const nameOf = (id: string | undefined): string | undefined => (id === undefined ? undefined : names.get(id.toLowerCase()));
  if (items) {
    tables.push(
      table<Item>("data/csv/items.csv", "One row per item and vehicle.", [
        col("id", "Item id (the key every other table uses).", (i) => i.id),
        col("kind", "`item` or `vehicle`.", (i) => i.kind),
        col("name", "Display name.", (i) => i.name),
        col("subtitle", "Short category line from the tooltip.", (i) => i.subtitle),
        col("description", "Short tooltip text; line breaks are kept inside the quoted cell.", (i) => i.description),
        col("icon", "Icon file under the release's `icons/` folder.", (i) => i.icon),
        col("developer", "True for development-only items (test and debug) that players cannot get.", (i) => i.developer),
        col("grid_width", "Inventory footprint width in cells.", (i) => i.grid[0]),
        col("grid_height", "Inventory footprint height in cells.", (i) => i.grid[1]),
        col("max_stack", "Units per inventory cell.", (i) => i.maxStack),
        col("weight", "Weight as stored by the game.", (i) => i.weight),
        col("durability", "Durability as stored by the game.", (i) => i.durability),
        col("unlock_role", "Progression tree that unlocks the item (empty when it needs no unlock).", (i) => i.unlock?.role),
        col("unlock_level", "Level needed in that tree.", (i) => i.unlock?.level),
        col("unlock_cost", "Cash cost to unlock.", (i) => i.unlock?.cost),
        col("tags", "Item context tags, separated by `;`.", (i) => list(i.tags)),
      ], items),
    );
    const prices = items.flatMap((item) => item.vendor.map((v) => ({ item, v })));
    type Price = (typeof prices)[number];
    tables.push(
      table<Price>("data/csv/prices.csv", "One row per way to buy an item. Ammo is sold in lots: `price` buys `amount` units.", [
        col("item_id", "Item id.", (r) => r.item.id),
        col("item_name", "Display name.", (r) => r.item.name),
        col("variation", "Vendor variation tag.", (r) => r.v.tag),
        col("price", "Price of one purchase.", (r) => r.v.price),
        col("amount", "Units one purchase gives.", (r) => r.v.amount),
        col("unit_price", "Price per unit (`price / amount`).", (r) => unitPrice(r.v.price, r.v.amount)),
        col("categories", "Vendor categories, separated by `;`.", (r) => list(r.v.categories)),
      ], prices),
    );
  }

  const weapons = get("data/weapons.json", WeaponsFile)?.weapons;
  if (weapons) {
    tables.push(
      table<Weapon>("data/csv/weapons.csv", "One row per weapon, with the headline numbers. Recoil patterns and damage falloff are in the JSON.", [
        col("id", "Item id.", (w) => w.id),
        col("name", "Display name from items.json.", (w) => nameOf(w.id)),
        col("fire_modes", "Fire modes, separated by `;`.", (w) => list(w.fireModes)),
        col("rpm", "Rounds per minute.", (w) => w.rpm),
        col("rounds_per_burst", "Rounds per burst.", (w) => w.roundsPerBurst),
        col("calibers", "Calibers fired, separated by `;`.", (w) => list(w.calibers)),
        col("muzzle_velocity_mps", "Muzzle velocity in meters per second.", (w) => w.muzzleVelocity),
        col("effective_range_m", "Range in meters the weapon is tuned for.", (w) => w.effectiveRange),
        col("accuracy", "Accuracy rating as stored.", (w) => w.accuracy),
        col("random_deviation_deg", "Random aim deviation in degrees.", (w) => w.randomDeviation),
        col("ads_time_s", "Seconds to aim down sights with iron sights.", (w) => w.adsTime),
        col("zeroing_min_m", "Shortest zeroing distance in meters.", (w) => w.zeroing?.min),
        col("zeroing_max_m", "Longest zeroing distance in meters.", (w) => w.zeroing?.max),
        col("zeroing_step_m", "Zeroing step in meters.", (w) => w.zeroing?.step),
        col("melee_damage", "Damage of a melee hit.", (w) => w.meleeDamage),
        col("suppression_multiplier", "Suppression multiplier.", (w) => w.suppressionMultiplier),
        col("windup_time_s", "Spin-up time in seconds.", (w) => w.windupTime),
        col("recoil_pattern_length", "Shots in the recoil pattern.", (w) => w.recoil?.pattern.length),
      ], weapons),
    );
    const slots = weapons.flatMap((w) => w.slots.map((s) => ({ w, s })));
    type Slot = (typeof slots)[number];
    tables.push(
      table<Slot>("data/csv/weapon-slots.csv", "One row per attachment slot of a weapon.", [
        col("weapon_id", "Item id of the weapon.", (r) => r.w.id),
        col("weapon_name", "Display name of the weapon.", (r) => nameOf(r.w.id)),
        col("slot", "Slot type.", (r) => r.s.slot),
        col("filter", "`AllowList` accepts only what is listed; `BlockPriority` accepts all except what is blocked.", (r) => r.s.filter),
        col("hidden", "True for slots players do not see (chamber, built-in parts).", (r) => r.s.hidden),
        col("default", "Item the weapon starts with.", (r) => r.s.default),
        col("default_name", "Display name of the default item.", (r) => nameOf(r.s.default)),
        col("items", "Items accepted by name, separated by `;`.", (r) => list(r.s.items)),
        col("contexts", "Item context tags accepted, separated by `;`.", (r) => list(r.s.contexts)),
        col("blocked_items", "Items refused by name, separated by `;`.", (r) => list(r.s.blockedItems)),
        col("blocked_contexts", "Context tags refused, separated by `;`.", (r) => list(r.s.blockedContexts)),
      ], slots),
    );
  }

  if (weapons && items) {
    // Which items fit which slot, resolved from the slot rules and the items' tags (see `fitsSlot`). A derived view: the
    // game's own check may have conditions that are not in the data. Hidden slots (chamber, built-in parts) are listed too.
    const rows = weapons.flatMap((w) =>
      w.slots.flatMap((slot) =>
        items.filter((i) => fitsSlot(i, slot)).map((i) => ({ w, slot, item: i })),
      ),
    );
    tables.push(
      table<(typeof rows)[number]>("data/csv/weapon-compatibility.csv", "One row per weapon, slot and item that fits it, resolved from the slot rules in weapons.json and the items' tags. The chamber slot lists the ammo each weapon accepts.", [
        col("weapon_id", "Item id of the weapon.", (r) => r.w.id),
        col("weapon_name", "Display name of the weapon.", (r) => nameOf(r.w.id)),
        col("slot", "Slot type.", (r) => r.slot.slot),
        col("item_id", "Item that fits the slot.", (r) => r.item.id),
        col("item_name", "Display name of the item.", (r) => r.item.name),
        col("is_default", "True when the weapon starts with this item in the slot.", (r) => r.slot.default !== undefined && r.slot.default.toLowerCase() === r.item.id.toLowerCase()),
      ], rows),
    );
  }

  const projectiles = get("data/ammo.json", AmmoFile)?.projectiles;
  if (weapons && projectiles) {
    // A weapon fires every projectile of its caliber, including sub-calibers (12g also covers 12g.RifledSlug).
    // Projectiles that no ammo item fires, or only developer items fire (the debug rocket), are skipped.
    const developer = new Set((items ?? []).filter((i) => i.developer).map((i) => i.id));
    const rows = weapons.flatMap((w) =>
      w.calibers.flatMap((cal) =>
        projectiles
          .filter((p) => p.items.some((id) => !developer.has(id)) && (p.id === `Item.Caliber.${cal}` || p.id.startsWith(`Item.Caliber.${cal}.`)))
          .map((p) => ({ w, p })),
      ),
    );
    tables.push(
      table<(typeof rows)[number]>("data/csv/weapon-damage.csv", "One row per weapon and projectile it can fire, with the damage per hit and the raw damage per second. These are before distance falloff, armor and hit location: see `damage.json` for what happens to them.", [
        col("weapon_id", "Item id of the weapon.", (r) => r.w.id),
        col("weapon_name", "Display name of the weapon.", (r) => nameOf(r.w.id)),
        col("projectile", "Projectile id (caliber).", (r) => r.p.id),
        col("projectile_items", "Ammo items that fire it, separated by `;`.", (r) => list(r.p.items)),
        col("damage_per_hit", "Base damage of one hit.", (r) => r.p.damage),
        col("rpm", "Rounds per minute.", (r) => r.w.rpm),
        col("raw_dps", "Damage per second at the weapon's rate of fire: `damage_per_hit * rpm / 60`.", (r) => (r.w.rpm === undefined ? undefined : Math.round(((r.p.damage * r.w.rpm) / 60) * 100) / 100)),
        col("muzzle_velocity_mps", "Muzzle velocity in meters per second.", (r) => r.w.muzzleVelocity),
        col("effective_range_m", "Range in meters the weapon is tuned for.", (r) => r.w.effectiveRange),
        col("full_damage_range_m", "Distance up to which damage is not reduced by falloff.", (r) => fullDamageRange(r.w.damageFalloff)),
      ], rows),
    );
  }
  if (projectiles) {
    tables.push(
      table<Projectile>("data/csv/ammo.csv", "One row per projectile definition (ballistics).", [
        col("id", "Projectile id.", (p) => p.id),
        col("asset", "Game asset path (several projectiles can share an id).", (p) => p.asset),
        col("damage", "Damage of one hit before falloff, armor and hit location.", (p) => p.damage),
        col("damage_type", "Damage type tag.", (p) => p.damageType),
        col("mass_kg", "Projectile mass in kilograms.", (p) => p.massKg),
        col("diameter_mm", "Diameter in millimeters.", (p) => p.diameterMm),
        col("length_mm", "Length in millimeters.", (p) => p.lengthMm),
        col("drag_coefficient", "Drag coefficient.", (p) => p.drag?.coefficient),
        col("drag_model", "Drag model, such as G7.", (p) => p.drag?.model),
        col("typical_speed_mps", "Typical speed in meters per second.", (p) => p.typicalSpeed),
        col("penetrates", "False when the projectile never passes through surfaces.", (p) => p.penetration?.penetrates),
        col("exit_speed_multiplier", "Fraction of speed kept after passing through a surface.", (p) => p.penetration?.exitSpeedMultiplier),
        col("ricochet_min_angle_deg", "Impact angle above which it ricochets.", (p) => p.penetration?.ricochetMinAngle),
        col("explosive_radius_m", "Distance at which explosive damage reaches its minimum.", (p) => p.explosive?.radius),
        col("explosive_effective_radius_m", "Distance within which explosive damage is full.", (p) => p.explosive?.effectiveRadius),
        col("suppression", "Suppression caused by a near miss.", (p) => p.suppression),
        col("items", "Ammo items that fire it, separated by `;`.", (p) => list(p.items)),
        col("item_names", "Display names of those ammo items, separated by `;`.", (p) => list(p.items.map((id) => nameOf(id) ?? id))),
      ], projectiles),
    );
  }

  const attachments = get("data/attachments.json", AttachmentsFile)?.attachments;
  if (attachments) {
    tables.push(
      table<Attachment>("data/csv/attachments.csv", "One row per attachment.", [
        col("id", "Item id.", (a) => a.id),
        col("name", "Display name from items.json.", (a) => nameOf(a.id)),
        col("type", "Attachment type.", (a) => a.type),
        col("contexts", "Item context tags, separated by `;`.", (a) => list(a.contexts)),
        col("magazine_capacity", "Rounds a magazine holds.", (a) => a.magazine?.capacity),
        col("magazine_calibers", "Calibers a magazine takes, separated by `;`.", (a) => list(a.magazine?.calibers ?? [])),
      ], attachments),
    );
    const mods = attachments.flatMap((a) => [
      ...a.modifiers.map((m) => ({ id: a.id, target: "weapon", m })),
      ...a.characterModifiers.map((m) => ({ id: a.id, target: "character", m })),
    ]);
    type Mod = (typeof mods)[number];
    tables.push(
      table<Mod>("data/csv/attachment-modifiers.csv", "One row per change an attachment makes.", [
        col("attachment_id", "Item id of the attachment.", (r) => r.id),
        col("attachment_name", "Display name of the attachment.", (r) => nameOf(r.id)),
        col("target", "`weapon` for changes to the weapon, `character` for changes to the carrier.", (r) => r.target),
        col("attribute", "Attribute changed.", (r) => r.m.attribute),
        col("op", "How the value combines.", (r) => r.m.op),
        col("value", "The value (1.1 on a multiplier is +10%).", (r) => r.m.value),
      ], mods),
    );
  }

  const equipment = get("data/equipment.json", EquipmentFile);
  if (equipment) {
    tables.push(
      table<EquipmentFile["armor"][number]>("data/csv/armor.csv", "One row per armor or helmet item.", [
        col("id", "Item id.", (a) => a.id),
        col("name", "Display name from items.json.", (a) => nameOf(a.id)),
        col("slot", "`Armor` or `Helmet`.", (a) => a.slot),
        col("damage_context", "Target tag the damage rules use for this piece.", (a) => a.damageContext),
        col("covered_locations", "Body parts protected, separated by `;`.", (a) => list(a.coveredLocations)),
        col("durability", "Hit points of the armor.", (a) => a.durability),
        col("damage_reduction_new", "Percent of damage absorbed when new.", (a) => a.stages[0]?.damageReduction),
        col("damage_reduction_worn", "Percent of damage absorbed at the last wear stage.", (a) => a.stages.at(-1)?.damageReduction),
        col("density_new", "Plate density when new, as stored.", (a) => a.stages[0]?.density),
        col("density_worn", "Plate density at the last wear stage, as stored.", (a) => a.stages.at(-1)?.density),
      ], equipment.armor),
    );
    const mods = [
      ...equipment.armor.flatMap((a) => a.modifiers.map((m) => ({ source: a.id, m }))),
      ...equipment.weightClasses.flatMap((w) => w.modifiers.map((m) => ({ source: `weight:${w.name}`, m }))),
    ];
    tables.push(
      table<(typeof mods)[number]>("data/csv/equipment-modifiers.csv", "One row per change worn armor or a carried-weight class makes to the player.", [
        col("source", "An armor item id, or `weight:<class>` for a carried-weight class.", (r) => r.source),
        col("attribute", "Attribute changed.", (r) => r.m.attribute),
        col("op", "How the value combines.", (r) => r.m.op),
        col("value", "The value (0.95 on a multiplier is -5%).", (r) => r.m.value),
      ], mods),
    );
    tables.push(
      table<EquipmentFile["weightClasses"][number]>("data/csv/weight-classes.csv", "One row per carried-weight class.", [
        col("name", "Class name.", (w) => w.name),
        col("min_weight_kg", "Carried weight in kilograms from which the class applies.", (w) => w.minWeightKg),
      ], equipment.weightClasses),
    );
  }

  const buildables = get("data/buildables.json", BuildablesFile)?.buildables;
  if (buildables) {
    tables.push(
      table<(typeof buildables)[number]>("data/csv/buildables.csv", "One row per buildable structure.", [
        col("id", "Buildable id.", (b) => b.id),
        col("name", "Display name.", (b) => b.name),
        col("cost", "Building supplies it costs.", (b) => b.cost),
        col("max_health", "Hit points when fully built.", (b) => b.maxHealth),
        col("repair_speed_multiplier", "Repair speed compared with the standard rate.", (b) => b.repairSpeedMultiplier),
        col("max_stack", "Stack size when the game states one.", (b) => b.maxStack),
        col("damage_entity", "The `entity` of its rules in damage.json.", (b) => b.damageEntity),
        col("size_x_m", "Bounding box X in meters.", (b) => b.size?.[0]),
        col("size_y_m", "Bounding box Y in meters.", (b) => b.size?.[1]),
        col("size_z_m", "Bounding box Z in meters.", (b) => b.size?.[2]),
        col("tools", "Build tools that offer it, separated by `;`.", (b) => list(b.tools)),
        col("placement_rules", "Placement conditions, separated by `;`.", (b) => list(b.placementRules)),
      ], buildables),
    );
  }

  const tagTexts = get("data/tags.json", TagsFile)?.tags;
  if (tagTexts) {
    tables.push(
      table<(typeof tagTexts)[number]>("data/csv/tags.csv", "One row per tag with the text the game shows for it.", [
        col("tag", "The game's gameplay tag.", (t) => t.tag),
        col("text", "Display text.", (t) => t.text),
        col("source", "The game's table the text comes from.", (t) => t.source),
      ], tagTexts),
    );
  }

  const cosmetics = get("data/cosmetics.json", CosmeticsFile);
  if (cosmetics) {
    const setNames = new Map(cosmetics.sets.map((s) => [s.id, s.name]));
    tables.push(
      table<(typeof cosmetics.cosmetics)[number]>("data/csv/cosmetics.csv", "One row per cosmetic (skin, emote, faction logo, taxi livery).", [
        col("id", "Cosmetic id.", (c) => c.id),
        col("item", "Item, emote or vehicle it applies to.", (c) => c.item),
        col("item_name", "Display name of the item, when it is one.", (c) => nameOf(c.item)),
        col("set", "Set or category id.", (c) => c.set),
        col("set_name", "Display name of the set, when it has one.", (c) => setNames.get(c.set)),
        col("archetype", "Weapon archetype.", (c) => c.archetype),
        col("source", "The game's table it was read from.", (c) => c.source),
      ], cosmetics.cosmetics),
    );
  }

  const loot = get("data/loot.json", LootFile)?.tables;
  if (loot) {
    tables.push(
      table<(typeof loot)[number]>("data/csv/loot-tables.csv", "One row per loot table.", [
        col("id", "Loot table id.", (t) => t.id),
        col("spawn_chance", "Percent chance the loot spawns.", (t) => t.spawnChance),
        col("spawn_by_default", "Spawns at the start of a match.", (t) => t.spawnByDefault),
        col("initial_spawn_time_s", "Seconds before the first spawn.", (t) => t.initialSpawnTime),
        col("initial_spawn_points", "Spawn points at the start.", (t) => t.initialSpawnPoints),
        col("can_respawn", "Comes back after being taken.", (t) => t.canRespawn),
        col("respawn_time", "Respawn time as stored.", (t) => t.respawnTime),
        col("never_repeat_previous", "A respawn never repeats the previous item.", (t) => t.neverSelectPreviousItem),
        col("control_zone_only", "Spawns only inside the control zone.", (t) => t.spawnInsideControlZoneOnly),
        col("entries", "Number of items that can spawn.", (t) => t.items.length),
      ], loot),
    );
    const entries = loot.flatMap((t) => t.items.map((i) => ({ table: t.id, i })));
    tables.push(
      table<(typeof entries)[number]>("data/csv/loot-items.csv", "One row per item a loot table can spawn.", [
        col("table", "Loot table id.", (r) => r.table),
        col("item", "Item id.", (r) => r.i.item),
        col("item_name", "Display name of the item.", (r) => nameOf(r.i.item)),
        col("amount", "Units spawned.", (r) => r.i.amount),
        col("weight", "Relative chance among the table's entries.", (r) => r.i.weight),
        col("sub_items", "Items that spawn with it as `item*amount@chance%`, separated by `;`.", (r) => list(r.i.subItems.map((s) => `${s.item}*${s.amount}@${s.chance}%`))),
      ], entries),
    );
  }

  const skills = get("data/skills.json", SkillsFile)?.skills;
  if (skills) {
    tables.push(
      table<(typeof skills)[number]>("data/csv/skills.csv", "One row per role skill.", [
        col("id", "Skill id.", (k) => k.id),
        col("role", "Role whose tree holds the skill.", (k) => k.role),
        col("name", "Name shown in the skill tree.", (k) => k.name),
        col("description", "Description shown in the skill tree.", (k) => k.description),
        col("tree_row", "Ring of the role's tree, 0 for the innermost; empty when the skill is not placed.", (k) => k.layout?.row),
        col("tree_column", "Position around the ring; empty when the skill is not placed.", (k) => k.layout?.column),
        col("effects", "Names of the gameplay effects the skill applies, separated by `;`. Empty when the client files hold no effect data for the skill.", (k) => list([...new Set(k.effects.map((e) => e.effect))])),
      ], skills),
    );
    const levels = skills.flatMap((k) => k.effects.flatMap((e) => (e.levels ?? []).map((l) => ({ id: k.id, attribute: e.attribute, curve: e.curve, level: l.level, value: l.value }))));
    tables.push(
      table<(typeof levels)[number]>("data/csv/skill-levels.csv", "One row per point of a skill's level curve: the value of an attribute at a skill level.", [
        col("skill_id", "Skill id.", (r) => r.id),
        col("attribute", "Attribute the level scales.", (r) => r.attribute),
        col("curve", "The game's curve name.", (r) => r.curve),
        col("level", "Skill level.", (r) => r.level),
        col("value", "Value at that level.", (r) => r.value),
      ], levels),
    );
  }

  const challenge = get("data/challenge-rewards.json", ChallengeRewardsFile);
  if (challenge) {
    tables.push(
      table<(typeof challenge.events)[number]>("data/csv/challenge-reward-events.csv", "One row per in-match event the game defines, with its name and note.", [
        col("event", "Event id.", (e) => e.id),
        col("name", "The game's name for the event.", (e) => e.name),
        col("description", "The game's note on when the event pays.", (e) => e.description),
      ], challenge.events),
    );
    const payments = challenge.rewards.flatMap((r) => r.resources.map((p) => ({ id: r.id, ...p })));
    tables.push(
      table<(typeof payments)[number]>("data/csv/challenge-rewards.csv", "One row per payment of a reward: the formula in the game's own notation.", [
        col("reward", "Reward id.", (r) => r.id),
        col("resource", "What is paid.", (r) => r.resource),
        col("formula", "The amount as a formula over the names in the variables table.", (r) => r.formula),
        col("inputs", "Names in the formula that change with the situation (see the JSON for the conditions), separated by `;`.", (r) => list(r.inputs.map((i) => i.name))),
      ], payments),
    );
    const variables = payments.flatMap((p) => p.variables.map((v) => ({ id: p.id, resource: p.resource, v })));
    tables.push(
      table<(typeof variables)[number]>("data/csv/challenge-reward-variables.csv", "One row per number a reward formula uses.", [
        col("reward", "Reward id.", (r) => r.id),
        col("resource", "What the payment is.", (r) => r.resource),
        col("name", "Variable name.", (r) => r.v.name),
        col("type", "`literal`, `game` or `scaling`.", (r) => r.v.type),
        col("value", "The number, for a literal.", (r) => (r.v.type === "literal" ? r.v.value : undefined)),
        col("game_value", "The game value that fills it in, for type `game`.", (r) => (r.v.type === "game" ? r.v.game : undefined)),
        col("curve", "The curve it is read from, for type `scaling`.", (r) => (r.v.type === "scaling" ? r.v.curve : undefined)),
        col("curve_input", "The value looked up on the curve, for type `scaling`.", (r) => (r.v.type === "scaling" ? r.v.input : undefined)),
      ], variables),
    );
    const points = challenge.curves.flatMap((c) => c.points.map((p) => ({ id: c.id, ...p })));
    tables.push(
      table<(typeof points)[number]>("data/csv/reward-curve-points.csv", "One row per point of a reward curve.", [
        col("curve", "Curve id.", (r) => r.id),
        col("input", "The value looked up.", (r) => r.input),
        col("value", "The curve's value from this input on.", (r) => r.value),
        col("interpolation", "`constant` (a step), `linear` or `cubic`.", (r) => r.interpolation),
      ], points),
    );
  }

  const roles = get("data/roles.json", RolesFile)?.roles;
  if (roles) {
    const levels = roles.flatMap((r) => r.levels.map((l, i) => ({ role: r.id, level: l.level, xp: l.xp, next: r.levels[i + 1] ? r.levels[i + 1]!.xp - l.xp : undefined })));
    tables.push(
      table<(typeof levels)[number]>("data/csv/role-levels.csv", "One row per role level.", [
        col("role", "Role id.", (r) => r.role),
        col("level", "Role level.", (r) => r.level),
        col("xp", "Total role XP needed to reach the level.", (r) => r.xp),
        col("xp_to_next", "XP from this level to the next; empty at the top level.", (r) => r.next),
      ], levels),
    );
  }

  const meta = get("data/meta.json", MetaFile);
  if (meta) {
    tables.push(
      table<(typeof meta.goldMarket)[number]>("data/csv/gold-market.csv", "One row per cosmetic offered for gold bars.", [
        col("id", "Offer id, the same as the cosmetic's id in cosmetics.json.", (r) => r.id),
        col("category", "The set the offer belongs to.", (r) => r.category),
        col("entity", "The item, vehicle variant or emote it is for.", (r) => r.entity),
        col("gold_bars", "Price in gold bars.", (r) => r.goldBars),
        col("grid_index", "Position of the tile in the market grid of its category.", (r) => r.gridIndex),
        col("tile", "Tile size in the market.", (r) => r.tile),
        col("expiration", "The game's expiration rule.", (r) => r.expiration),
        col("expiration_time", "The time stored with the offer, UTC, when there is one.", (r) => r.expirationTime),
      ], meta.goldMarket),
    );
    const tiers = meta.passiveMissions.flatMap((m) => m.challenges.map((c, i) => ({ mission: m.id, tier: i + 1, c })));
    tables.push(
      table<(typeof tiers)[number]>("data/csv/passive-missions.csv", "One row per tier of a passive mission.", [
        col("mission", "Mission id.", (r) => r.mission),
        col("tier", "Tier, counted from 1 in the game's order.", (r) => r.tier),
        col("challenge", "Challenge id.", (r) => r.c.id),
        col("name", "Name shown in the game.", (r) => r.c.name),
        col("objective", "What is counted.", (r) => r.c.objective),
        col("target", "Amount of the objective to complete the tier (time in seconds).", (r) => r.c.target),
        col("reward_currency", "Currency paid.", (r) => r.c.reward.currency),
        col("reward_amount", "Amount paid.", (r) => r.c.reward.amount),
      ], tiers),
    );
    tables.push(
      table<(typeof meta.achievements)[number]>("data/csv/achievements.csv", "One row per achievement.", [
        col("id", "Achievement id.", (r) => r.id),
        col("steam_id", "The achievement's id on Steam.", (r) => r.steamId),
        col("name", "Name shown in the game.", (r) => r.name),
        col("description", "What the achievement asks for, when the game words it.", (r) => r.description),
        col("thresholds", "The numbers the game sets for the condition, as `name=value` separated by `;`.", (r) => list(Object.entries(r.thresholds ?? {}).map(([n, v]) => `${n}=${v}`))),
      ], meta.achievements),
    );
  }

  const rewards = get("data/rewards.json", RewardsFile)?.rewards;
  if (rewards) {
    tables.push(
      table<(typeof rewards)[number]>("data/csv/rewards.csv", "One row per cash reward case.", [
        col("action", "What earns the reward.", (r) => r.action),
        col("context", "The case within the action.", (r) => r.context),
        col("resource", "What is paid.", (r) => r.resource),
        col("base", "Base amount.", (r) => r.base),
        col("description", "The game's own note on when the case applies.", (r) => r.description),
      ], rewards),
    );
    const modifiers = rewards.flatMap((r) => Object.entries(r.modifiers).map(([name, value]) => ({ r, name, value })));
    tables.push(
      table<(typeof modifiers)[number]>("data/csv/reward-modifiers.csv", "One row per modifier of a reward case, named as the game names it.", [
        col("action", "What earns the reward.", (m) => m.r.action),
        col("context", "The case within the action.", (m) => m.r.context),
        col("modifier", "Modifier name.", (m) => m.name),
        col("value", "Modifier value.", (m) => m.value),
      ], modifiers),
    );
  }

  const damage = get("data/damage.json", DamageFile);
  if (damage) {
    tables.push(
      table<DamageFile["rules"][number]>("data/csv/damage-rules.csv", "One row per damage rule. Tag lists are separated by `;`.", [
        col("entity", "What the rule belongs to (`Infantry`, `Armor`, one vehicle, a buildable).", (r) => r.entity),
        col("source", "Tags the incoming damage must carry, separated by `;`.", (r) => list(r.source)),
        col("target", "Tags the target must carry, separated by `;`.", (r) => list(r.target)),
        col("instigator", "Tags the attacker must carry, separated by `;`.", (r) => list(r.instigator)),
        col("hit_locations", "Hit locations the rule is limited to, separated by `;`.", (r) => list(r.hitLocations)),
        col("alignment", "`Friendly` for teammate-only rules.", (r) => r.alignment),
        col("category", "The group the game applies the rule in.", (r) => r.category),
        col("operation", "How the amount changes the damage.", (r) => r.operation),
        col("amount", "The amount (a percentage for `Percentage_Ongoing`).", (r) => r.amount),
        col("custom", "The game's own code for rules that are not plain percentages.", (r) => r.custom),
      ], damage.rules),
    );
    const cells = damage.hitLocationMultipliers.flatMap((c) => Object.entries(c.multipliers).map(([location, multiplier]) => ({ weaponClass: c.weaponClass, location, multiplier })));
    tables.push(
      table<(typeof cells)[number]>("data/csv/hit-location-multipliers.csv", "Damage multiplier per body part and weapon class.", [
        col("weapon_class", "`Universal` or a weapon class such as `Weapon.AR`.", (r) => r.weaponClass),
        col("hit_location", "Body part, such as `Head` or `Torso.Upper`.", (r) => r.location),
        col("multiplier", "Damage multiplier.", (r) => r.multiplier),
      ], cells),
    );
  }

  const vehicles = get("data/vehicles.json", VehiclesFile)?.vehicles;
  if (vehicles) {
    tables.push(
      table<Vehicle>("data/csv/vehicles.csv", "One row per vehicle variant.", [
        col("id", "Vehicle item id.", (v) => v.id),
        col("name", "Display name from items.json.", (v) => nameOf(v.id)),
        col("max_speed_kmh", "Top speed in km/h.", (v) => v.maxSpeed),
        col("max_fuel_l", "Fuel tank in liters.", (v) => v.maxFuel),
        col("fuel_economy_l_per_km", "Fuel use as shown in the shop, liters per kilometer.", (v) => v.fuelEconomy),
        col("km_per_liter", "Distance one liter of fuel lasts, as stored.", (v) => v.kmPerLiter),
        col("health", "Hit points of a new vehicle.", (v) => v.health?.initial),
        col("critical_threshold", "Health at or below which the vehicle is critical, as stored.", (v) => v.health?.criticalThreshold),
        col("bleed_out_time", "Seconds a critical vehicle lasts, as stored.", (v) => v.health?.bleedOutTime),
        col("damage_entity", "The `entity` of its damage rules in damage.json.", (v) => v.damageEntity),
        col("wreck_explosion_radius_m", "Distance at which the wreck explosion reaches its minimum damage.", (v) => v.destroyedExplosion?.radius),
        col("wreck_explosion_effective_radius_m", "Distance within which the wreck explosion does full damage.", (v) => v.destroyedExplosion?.effectiveRadius),
        col("mass_kg", "Mass of the vehicle body as the game's physics stores it (wheeled vehicles and helicopters).", (v) => v.mass),
        col("idle_rpm", "Engine idle speed, when the game stores one.", (v) => v.engine?.idleRpm),
        col("limit_rpm", "Engine rev limiter, when the game stores one.", (v) => v.engine?.limitRpm),
        col("peak_torque", "Highest torque on the engine's curve, as stored.", (v) => (v.engine ? Math.max(...v.engine.torqueCurve.map((k) => k.torque)) : undefined)),
        col("gear_ratios", "Gear ratios in stored order, separated by `;`.", (v) => (v.transmission ? list(v.transmission.gearRatios.map(String)) : undefined)),
        col("final_gear_ratio", "Final drive ratio.", (v) => v.transmission?.finalGearRatio),
        col("seats", "Number of seats.", (v) => v.seats),
        col("weapons", "Weapons listed in the shop, separated by `;`.", (v) => list(v.weapons)),
        col("counter_measures", "Countermeasures listed in the shop, separated by `;`.", (v) => list(v.counterMeasures)),
      ], vehicles),
    );
  }

  for (const [path, raw] of files) {
    const m = /^data\/maps\/([^/]+)\/buildings\.json$/.exec(path);
    if (!m) continue;
    tables.push(
      table<Building>(`data/csv/buildings-${m[1]}.csv`, `One row per destructible building of the ${m[1]} world, as an axis-aligned box in meters.`, [
        col("id", "Building id.", (b) => b.id),
        col("kind", "Building kind.", (b) => b.kind),
        col("class", "Blueprint class.", (b) => b.class),
        col("min_x", "Minimum X.", (b) => b.min[0]),
        col("min_y", "Minimum Y.", (b) => b.min[1]),
        col("min_z", "Minimum Z (the base).", (b) => b.min[2]),
        col("max_x", "Maximum X.", (b) => b.max[0]),
        col("max_y", "Maximum Y.", (b) => b.max[1]),
        col("max_z", "Maximum Z (the roof).", (b) => b.max[2]),
        col("parts", "Mesh parts merged into the box.", (b) => b.parts),
      ], BuildingsFile.parse(raw).buildings),
    );
  }

  const zoneRows: Array<{ world: string; config: string; mode: string; id: string; weight: number | undefined; zone: ObjectivesFile["configs"][number]["zone"] }> = [];
  for (const [path, raw] of files) {
    if (!/^data\/maps\/[^/]+\/objectives\.json$/.test(path)) continue;
    const file = ObjectivesFile.parse(raw);
    for (const c of file.configs) {
      zoneRows.push({ world: file.world, config: c.config, mode: c.mode, id: "default", weight: undefined, zone: c.zone });
      for (const a of c.alternatives) zoneRows.push({ world: file.world, config: c.config, mode: c.mode, id: a.id, weight: a.weight, zone: a.zone });
    }
  }
  if (zoneRows.length) {
    tables.push(
      table<(typeof zoneRows)[number]>("data/csv/control-zones.csv", "One row per control zone placement of every world: the default one and each alternative.", [
        col("world", "World name.", (r) => r.world),
        col("config", "The game's control zone configuration asset.", (r) => r.config),
        col("mode", "`Standard` or the name of a game mode variant.", (r) => r.mode),
        col("placement", "`default`, or the game's tag for an alternative placement.", (r) => r.id),
        col("weight", "Relative chance an alternative is chosen (empty for the default).", (r) => r.weight),
        col("x", "Center X in meters.", (r) => r.zone.center[0]),
        col("y", "Center Y in meters.", (r) => r.zone.center[1]),
        col("z", "Center Z in meters.", (r) => r.zone.center[2]),
        col("shape", "Zone shape when the game states one.", (r) => r.zone.shape),
        col("radius_m", "Control zone radius (x extent) in meters.", (r) => r.zone.extents[0]),
        col("half_height_m", "Control zone half height (z extent) in meters.", (r) => r.zone.extents[2]),
        col("hot_zone_radius_m", "Hot zone radius in meters.", (r) => r.zone.hotZone.extents[0]),
      ], zoneRows),
    );
  }

  for (const [path, raw] of files) {
    const m = /^data\/maps\/([^/]+)\/objects\.json$/.exec(path);
    if (!m) continue;
    tables.push(
      table<WorldObjectsFile["objects"][number]>(`data/csv/objects-${m[1]}.csv`, `One row per placed gameplay object of the ${m[1]} world.`, [
        col("id", "Object id.", (o) => o.id),
        col("kind", "What the object is.", (o) => o.kind),
        col("class", "Blueprint class.", (o) => o.class),
        col("x", "Position X in meters.", (o) => o.position[0]),
        col("y", "Position Y in meters.", (o) => o.position[1]),
        col("z", "Position Z in meters.", (o) => o.position[2]),
        col("yaw_deg", "Heading in degrees.", (o) => o.yaw),
        col("faction", "Team (`Alpha` or `Bravo`).", (o) => o.faction),
        col("scale_x", "Actor scale X as stored.", (o) => o.scale?.[0]),
        col("scale_y", "Actor scale Y as stored.", (o) => o.scale?.[1]),
        col("scale_z", "Actor scale Z as stored.", (o) => o.scale?.[2]),
        col("allowed_vehicles", "Vehicles a spawn volume may spawn, separated by `;`.", (o) => list(o.allowedVehicles ?? [])),
        col("disallowed_vehicles", "Vehicles a spawn volume never spawns, separated by `;`.", (o) => list(o.disallowedVehicles ?? [])),
      ], WorldObjectsFile.parse(raw).objects),
    );
  }

  return tables.sort((a, b) => a.path.localeCompare(b.path));
}
