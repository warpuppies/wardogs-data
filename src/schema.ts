import { z } from "zod";

export const Variation = z.object({
  tag: z.string().min(1).describe("Vendor variation tag. Equals the item id for the base item; variants append a suffix."),
  price: z.number().nonnegative().describe("Price of one purchase, in the game's cash."),
  amount: z.number().int().positive().describe("Units sold per purchase at `price` (ammo is sold in lots)."),
  categories: z.array(z.string()).describe("Vendor categories the entry is listed under, for example `Vendor.Category.Attachment`."),
});
export type Variation = z.infer<typeof Variation>;

export const Unlock = z.object({
  role: z.string().min(1).describe("Progression tree: Infantry, Support, Medic, Recon, Pilot, Driver, or Wardog (the account-wide career level)."),
  level: z.number().int().positive().describe("Minimum level in that tree."),
  cost: z.number().nonnegative().describe("Cash cost to unlock."),
}).describe("What it takes to unlock an item in the progression trees.");
export type Unlock = z.infer<typeof Unlock>;

export const Item = z.object({
  id: z.string().min(1).describe("Stable identifier from the game. Forms seen: `Id.Item.*`, `ID.Item.*` and `Vehicle.*`."),
  kind: z.enum(["item", "vehicle"]).describe("`vehicle` for ids starting with `Vehicle.`, otherwise `item`."),
  asset: z.string().min(1).describe("Path of the item definition inside the game files."),
  name: z.string().min(1).describe("Display name: the definition's own name, else the one in the UI tables, else the id."),
  subtitle: z.string().min(1).optional().describe("Short category line shown under the name in tooltips, such as \"Assault Rifle\" or \"Truck\"."),
  description: z.string().min(1).optional().describe("Short tooltip text (a one-line summary or a few stat bullets, joined with newlines)."),
  icon: z.string().min(1).optional().describe("The icon the game shows for this item in the inventory and the shop, as a PNG path relative to the release's `icons/` folder. Several items can share one icon. Absent for parts with no icon in the game (built-in barrels and stocks, vehicle turrets, storage)."),
  developer: z.literal(true).optional().describe("True for items the game ships for development (test and debug items) that players cannot get. Join on this to leave them out of weapons, ammunition and other files that refer to items."),
  tags: z.array(z.string()).describe("The item's context tags, which describe what it is and where it can go (`Item.Attachment.Muzzle`, `Inventory.Slot.Primary`)."),
  grid: z.tuple([z.number().int().positive(), z.number().int().positive()]).describe("Inventory footprint in cells: [width, height]."),
  maxStack: z.number().int().positive().describe("Max units per inventory cell (1 when the item is not stackable)."),
  weight: z.number().nonnegative().optional().describe("Weight as stored by the game."),
  durability: z.number().positive().optional().describe("Durability as stored by the game, for items that wear."),
  unlock: Unlock.nullable().describe("Null when the item is available without unlocking (or is not part of a tree)."),
  vendor: z.array(Variation).describe("Ways to buy the item. Empty when no shop sells it."),
});
export type Item = z.infer<typeof Item>;

/** Id prefixes the pipeline knows about. A new prefix after a game update fails the tests so it is reviewed. */
export const KNOWN_ID_PATTERN = /^(Id\.Item\.|ID\.Item\.|Vehicle\.)/;

/**
 * Ids that break the naming pattern in the game files themselves. Each entry is reviewed and explained;
 * anything else outside KNOWN_ID_PATTERN fails the tests.
 */
export const KNOWN_ID_QUIRKS: Readonly<Record<string, string>> = {
  "Id.Item": "ID_FuelCan_20L is saved with a truncated ItemId",
};

/**
 * Items that exist only for development: named as tests in the game's own data and not for sale, unlockable or placed
 * anywhere. Declared one by one with the evidence, because names are not enough (the field resuscitator lives in a folder
 * called `ResuscitatorTest` and is a real, priced item). They stay in the data, flagged with `developer`.
 */
export const DEVELOPER_ITEMS: Readonly<Record<string, string>> = {
  "Id.Item.ArtilleryBarrelTest": "'Artillery Barrel Test' in the vehicle barrel test folder; not sold or unlocked",
  "Id.Item.DebugHomingRocketAmmo": "'RocketTesting 84mm' in the debug homing rocket folder; not sold or unlocked",
};

export const isKnownId = (id: string): boolean => KNOWN_ID_PATTERN.test(id) || id in KNOWN_ID_QUIRKS;

export const ItemsFile = z.object({
  schemaVersion: z.literal(1).describe("Version of this file's layout. It changes only when the layout does."),
  gameBuild: z.string().describe("Steam build id the data was extracted from."),
  items: z.array(Item).describe("One entry per item and vehicle definition, sorted by id."),
}).describe("Every item and vehicle: names, tooltip text, icon, inventory size, stacking, vendor prices and unlock requirements.");
export type ItemsFile = z.infer<typeof ItemsFile>;

const Meters = z.number().finite();
const Point2 = z.tuple([Meters, Meters]);
const Point3 = z.tuple([Meters, Meters, Meters]);

export const MapFile = z.object({
  schemaVersion: z.literal(1).describe("Version of this file's layout. It changes only when the layout does."),
  id: z.string().regex(/^[a-z-]+$/).describe("Short id of the world, also its folder name under `data/maps`."),
  name: z.string().min(1).describe("Map name shown in the game's server browser."),
  world: z.string().min(1).describe("Name of the world (level) the map belongs to."),
  gameBuild: z.string().describe("Steam build id the data was extracted from."),
  units: z.literal("meters").describe("Unit of every distance in the file."),
  bounds: z.object({ min: Point2.describe("Minimum corner: [x, y] in meters."), max: Point2.describe("Maximum corner: [x, y] in meters.") }).describe("Area the map covers, as world X and Y. Pixel (0, 0) of the image is the minimum corner."),
  image: z.object({
    width: z.number().int().positive().describe("Image width in pixels."),
    height: z.number().int().positive().describe("Image height in pixels."),
    metersPerPixel: z.number().positive().describe("World meters per image pixel. `pixel = (world - bounds.min) / metersPerPixel`; rows increase with world Y."),
    padding: z.object({ right: z.number().int().nonnegative().describe("Padding columns on the right edge."), bottom: z.number().int().nonnegative().describe("Padding rows on the bottom edge.") }).describe("Pixels past the bounds on the right and bottom edges. They hold padding, not map."),
  }).describe("The single full-size map image the tiles were cut from."),
  tiles: z.object({
    size: z.literal(256).describe("Tile size in pixels (tiles are square)."),
    minZoom: z.literal(0).describe("Lowest zoom level (one tile covers the whole map)."),
    maxZoom: z.number().int().nonnegative().describe("At this zoom the tiles cover the full image at 1:1 (`image.width = 256 * 2^maxZoom`)."),
    format: z.literal("webp").describe("Tile image format."),
    urlTemplate: z.string().describe("Path of a tile inside the release's map folder; replace `{z}`, `{x}` and `{y}`."),
  }).describe("The tile pyramid published as a release asset."),
}).describe("Metadata that places a world's map image and tiles in world coordinates. All distances are meters.");
export type MapFile = z.infer<typeof MapFile>;

export const BUILDING_KINDS = ["bungalow", "house", "apartment", "warehouse", "market", "shop", "garage", "office", "supply", "pool"] as const;

export const Building = z.object({
  id: z.string().regex(/^[0-9a-f]{12}$/).describe("Stable id derived from the placed actor's name."),
  kind: z.enum(BUILDING_KINDS).describe("Building category, derived from the blueprint class."),
  class: z.string().min(1).describe("Blueprint class of the building."),
  min: Point3.describe("Minimum corner of the box: [x, y, z] in meters."),
  max: Point3.describe("Maximum corner of the box: [x, y, z] in meters."),
  parts: z.number().int().positive().describe("Number of mesh parts whose bounds were merged into the box."),
});
export type Building = z.infer<typeof Building>;

export const BuildingsFile = z.object({
  schemaVersion: z.literal(1).describe("Version of this file's layout. It changes only when the layout does."),
  world: z.string().min(1).describe("Name of the world (level) the buildings are in."),
  gameBuild: z.string().describe("Steam build id the data was extracted from."),
  units: z.literal("meters").describe("Unit of every distance in the file."),
  shape: z.literal("axis-aligned bounding box").describe("How each building is represented."),
  count: z.number().int().nonnegative().describe("Number of buildings."),
  buildings: z.array(Building).describe("Buildings, sorted by id."),
}).describe("Destructible buildings of one world as axis-aligned boxes. Z is up. Boxes enclose, so they overestimate.");
export type BuildingsFile = z.infer<typeof BuildingsFile>;

export const TerrainFile = z.object({
  schemaVersion: z.literal(1).describe("Version of this file's layout. It changes only when the layout does."),
  id: z.string().regex(/^[a-z-]+$/).describe("Short id of the world, also its folder name under `data/maps`."),
  world: z.string().min(1).describe("Name of the world (level) the terrain belongs to."),
  gameBuild: z.string().describe("Steam build id the data was extracted from."),
  units: z.literal("meters").describe("Unit of every distance in the file."),
  bounds: z.object({ min: Point2.describe("Minimum corner: [x, y] in meters."), max: Point2.describe("Maximum corner: [x, y] in meters.") }).describe("Area the heightmap covers, as world X and Y. Pixel (0, 0) is the minimum corner."),
  zRange: z.object({ min: Meters.describe("World Z in meters of pixel value 0."), max: Meters.describe("World Z in meters of pixel value 65535.") }).describe("World Z of pixel value 0 and of pixel value 65535."),
  heightmap: z.object({
    file: z.literal("heightmap.png").describe("File name inside the release's map folder."),
    width: z.number().int().positive().describe("Image width in pixels."),
    height: z.number().int().positive().describe("Image height in pixels."),
    bitDepth: z.literal(16).describe("Bits per pixel."),
    metersPerPixel: Point2.describe("World meters per pixel along X and Y. Rows increase with world Y."),
    encoding: z.literal("z = zRange.min + value / 65535 * (zRange.max - zRange.min)").describe("How to turn a pixel value into a height."),
  }).describe("The 16-bit grayscale height image."),
  check: z.object({
    buildings: z.number().int().nonnegative().describe("Buildings used in the check."),
    medianOffset: Meters.describe("Median offset in meters."),
    p5Offset: Meters.describe("5th percentile offset in meters."),
    p95Offset: Meters.describe("95th percentile offset in meters."),
    fractionWithin5m: z.number().min(0).max(1).describe("Share of buildings whose base is within 5 m of the terrain."),
  }).describe("Self-check against the buildings: base of each building minus the terrain height under its centre."),
}).describe("Metadata for a world's baked terrain height image (a release asset, `heightmap.png`). All distances are meters.");
export type TerrainFile = z.infer<typeof TerrainFile>;

const Extents = z.tuple([Meters, Meters, Meters]);

export const ObjectiveZone = z
  .object({
    center: Point3.describe("Center of the control zone: [x, y, z] in meters."),
    extents: Extents.describe("Size of the control zone as the game stores it, in meters: for a cylinder, x and y are the radius and z the half height."),
    shape: z.string().optional().describe("Zone shape, for example `Cylinder`. Absent when the game leaves it at its default."),
    hotZone: z
      .object({
        extents: Extents.describe("Size of the hot zone (the moving capture area inside the control zone), in meters, read like `extents`."),
        shape: z.string().optional().describe("Hot zone shape. Absent when the game leaves it at its default."),
      })
      .describe("The hot zone inside the control zone."),
  })
  .describe("A control zone and the hot zone inside it.");
export type ObjectiveZone = z.infer<typeof ObjectiveZone>;

export const ObjectivesFile = z
  .object({
    schemaVersion: z.literal(1).describe("Version of this file's layout. It changes only when the layout does."),
    world: z.string().min(1).describe("Name of the world (level) the objectives are in."),
    gameBuild: z.string().describe("Steam build id the data was extracted from."),
    units: z.literal("meters").describe("Unit of every distance in the file."),
    configs: z
      .array(
        z.object({
          config: z.string().min(1).describe("Name of the game's control zone configuration asset."),
          mode: z.string().min(1).describe("`Standard` for the normal match, otherwise the name of the game mode variant (for example `SniperShowdown`)."),
          zone: ObjectiveZone.describe("The default control zone."),
          alternatives: z
            .array(
              z.object({
                id: z.string().min(1).describe("The game's tag for this placement, for example `ZoneAlternator.Bakurani.Farmland.Circle`."),
                weight: z.number().finite().nonnegative().describe("Relative chance the placement is chosen. 0 means it is never chosen."),
                zone: ObjectiveZone,
              }),
            )
            .describe("Other places the control zone can be put at the start of a match. Empty when the zone never moves."),
          hotZoneMovement: z
            .object({
              firstMoveDelay: z.number().finite().optional().describe("Seconds before the hot zone first moves."),
              moveDelay: z.number().finite().optional().describe("Seconds of delay before the hot zone moves, as stored (the game's `MoveDelay`)."),
              innerRadiusFraction: z.number().finite().optional().describe("The game's `HotZoneInnerRadiusPercentage`, as stored (0.95 on the standard configurations). It limits how far toward the control zone's edge the hot zone may go."),
              defaultSpeed: z.number().finite().optional().describe("Hot zone speed multiplier, as stored (the game's `DefaultSpeed`)."),
              dynamicSpeeds: z.boolean().optional().describe("True when the hot zone uses the speeds listed in `speeds` (the game's `bUseDynamicHotzoneSpeeds`)."),
              speeds: z.array(z.number().finite()).describe("The game's `HotzoneSpeeds` list, as stored."),
              minMoveDistance: z.number().finite().optional().describe("Shortest move of the hot zone, in meters."),
            })
            .describe("How the hot zone moves inside the control zone."),
        }),
      )
      .describe("One entry per control zone configuration the game has for the world."),
  })
  .describe("Match objectives of one world: where the control zone and its hot zone are, how big they are, and how the hot zone moves.");
export type ObjectivesFile = z.infer<typeof ObjectivesFile>;

export const OBJECT_KIND_NAMES = [
  "equipment-vendor",
  "vehicle-vendor",
  "garage-vendor",
  "safe-zone",
  "safe-zone-camera",
  "spawn-manager",
  "spawn-volume",
  "vehicle-deployment-board",
  "fuel-refill",
] as const;

export const WorldObject = z
  .object({
    id: z.string().regex(/^[0-9a-f]{12}$/).describe("Stable id derived from the placed actor's name and the level it is in."),
    kind: z.enum(OBJECT_KIND_NAMES).describe("What the object is: a shop (`equipment-vendor`, `vehicle-vendor`, `garage-vendor`), a team `safe-zone` with its `safe-zone-camera`, a team `spawn-manager`, a `spawn-volume` that vehicles appear in, a `vehicle-deployment-board` or a `fuel-refill` crate."),
    class: z.string().min(1).describe("Blueprint class of the actor."),
    position: Point3.describe("Position: [x, y, z] in meters."),
    yaw: z.number().finite().optional().describe("Heading in degrees. Absent when the object is not rotated."),
    scale: Point3.optional().describe("Actor scale as stored. For a safe zone this sizes its trigger box. Absent when the game leaves it at 1."),
    faction: z.string().optional().describe("The team the object belongs to (`Alpha` or `Bravo`). Absent for neutral objects."),
    tags: z.array(z.string()).optional().describe("Tags the object applies to people inside it (safe zones)."),
    allowedVehicles: z.array(z.string()).optional().describe("Vehicle ids a spawn volume may spawn (see items.json)."),
    disallowedVehicles: z.array(z.string()).optional().describe("Vehicle ids and vehicle families a spawn volume never spawns."),
  })
  .describe("A placed gameplay object.");
export type WorldObject = z.infer<typeof WorldObject>;

export const WorldObjectsFile = z
  .object({
    schemaVersion: z.literal(1).describe("Version of this file's layout. It changes only when the layout does."),
    world: z.string().min(1).describe("Name of the world (level) the objects are in."),
    gameBuild: z.string().describe("Steam build id the data was extracted from."),
    units: z.literal("meters").describe("Unit of every distance in the file."),
    count: z.number().int().nonnegative().describe("Number of objects."),
    objects: z.array(WorldObject).describe("Objects, sorted by kind and then position."),
  })
  .describe("Gameplay objects placed in one world: shops, safe zones, spawn managers and volumes, vehicle deployment boards and fuel refills. Coordinates are the same as in map.json.");
export type WorldObjectsFile = z.infer<typeof WorldObjectsFile>;
