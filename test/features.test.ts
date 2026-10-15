import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { BuildablesFile, CosmeticsFile, DamageFile, LootFile, TagsFile } from "../src/schema.gameplay.js";
import { ItemsFile } from "../src/schema.js";
import type { RawExport } from "../src/transform/items.js";
import { buildFeaturesData, conditionName, parseBuildable, parseCosmeticSets, parseCosmetics, parseLootTables, parseTagTexts, parseToolBuildables } from "../src/transform/features.js";

const asset = (over: Record<string, unknown> = {}): RawExport => ({
  Type: "WDBuildableDataAsset",
  Properties: {
    EntityTag: { TagName: "Id.Buildable.Wall" },
    Cost: 15,
    MaxHealth: 735,
    DisplayName: { LocalizedString: "Wall", SourceString: "Wall" },
    RepairSpeedMultiplier: 6.67,
    MaxStack: 100,
    DamageEntityData: { Tag: { TagName: "Meta.Damage.Buildable.Wall" } },
    FinalStageBoundingBox: { Min: { X: -150, Y: -15, Z: 0 }, Max: { X: 150, Y: 15, Z: 100 }, IsValid: 1 },
    PlacementConditions: [{ ObjectName: "BlueprintGeneratedClass'B_SafeZonePlacementCondition_C'" }, { ObjectName: "Class'WDWithinFobBoundsPlacementCondition'" }],
    ...over,
  } as never,
});

describe("conditionName", () => {
  it("shortens blueprint and native condition class names", () => {
    expect(conditionName("BlueprintGeneratedClass'B_SafeZonePlacementCondition_C'")).toBe("SafeZone");
    expect(conditionName("Class'WDWithinFobBoundsPlacementCondition'")).toBe("WithinFobBounds");
    expect(conditionName("BlueprintGeneratedClass'B_WithinLadderBoundsPlacementCondition_C'")).toBe("WithinLadderBounds");
    expect(conditionName(undefined)).toBeUndefined();
  });
});

describe("parseBuildable", () => {
  it("reads cost, health, size in meters, damage entity and placement rules", () => {
    expect(parseBuildable(asset())).toEqual({
      id: "Id.Buildable.Wall",
      name: "Wall",
      cost: 15,
      maxHealth: 735,
      repairSpeedMultiplier: 6.67,
      maxStack: 100,
      damageEntity: "Buildable.Wall",
      size: [3, 0.3, 1],
      tools: [],
      placementRules: ["SafeZone", "WithinFobBounds"],
    });
  });

  it("treats a stack of 0 as no stacking, and omits an invalid bounding box", () => {
    const b = parseBuildable(asset({ MaxStack: 0, FinalStageBoundingBox: { IsValid: 0 } }))!;
    expect(b).not.toHaveProperty("maxStack");
    expect(b).not.toHaveProperty("size");
  });

  it("returns null without an id, a cost or positive health", () => {
    expect(parseBuildable(asset({ EntityTag: {} }))).toBeNull();
    expect(parseBuildable(asset({ Cost: undefined }))).toBeNull();
    expect(parseBuildable(asset({ MaxHealth: 0 }))).toBeNull();
  });
});

describe("parseToolBuildables", () => {
  it("lists the buildable ids a tool offers, by tag or by row key", () => {
    const exports: RawExport[] = [{ Type: "DataTable", Rows: { A: { Tag: { TagName: "Id.Buildable.A" } }, "Id.Buildable.B": {} } as never }];
    expect(parseToolBuildables(exports)).toEqual(["Id.Buildable.A", "Id.Buildable.B"]);
  });
});

describe("parseLootTables", () => {
  const table = (rows: unknown): RawExport[] => [{ Type: "DataTable", Properties: { RowStruct: { ObjectName: "Class'WDLootableDataTable'" } } as never, Rows: rows as never }];

  it("reads weighted items with their sub-items and the respawn rules", () => {
    const tables = parseLootTables(
      table({
        "Lootable.Tower": {
          LootableData: {
            ItemsToSpawn: [{ ItemTag: { TagName: "Id.Item.SV98" }, ItemAmount: 1, ItemSpawnWeight: 0.8, SubItemsSpawnData: [{ SubItemTag: { TagName: "Id.Item.Scope" }, SubSpawnChance: 100, SubItemAmount: 1 }] }, { ItemTag: { TagName: "None" } }],
            SpawnChance: 50,
            bCanRespawn: true,
            RespawnTime: 300,
            InitialSpawnPoints: 15,
          },
          bSpawnInsideControlZoneOnly: false,
        },
      }),
    );
    expect(tables).toEqual([
      {
        id: "Tower",
        spawnChance: 50,
        canRespawn: true,
        respawnTime: 300,
        initialSpawnPoints: 15,
        spawnInsideControlZoneOnly: false,
        items: [{ item: "Id.Item.SV98", amount: 1, weight: 0.8, subItems: [{ item: "Id.Item.Scope", chance: 100, amount: 1 }] }],
      },
    ]);
  });

  it("ignores tables of other row structs", () => {
    expect(parseLootTables([{ Type: "DataTable", Properties: { RowStruct: { ObjectName: "Class'Other'" } } as never, Rows: { x: {} } as never }])).toEqual([]);
  });
});

describe("buildFeaturesData", () => {
  it("joins buildables with the tools that offer them and notes tool rows without an asset", () => {
    const raw = mkdtempSync(join(tmpdir(), "wardogs-features-"));
    const put = (path: string, value: unknown) => {
      mkdirSync(dirname(join(raw, path)), { recursive: true });
      writeFileSync(join(raw, path), JSON.stringify(value));
    };
    put("gameplay/Wardogs/Plugins/GameFeatures/Items/Buildables/Content/Data/Buildables/Wall/DA_Buildable_Wall.json", [asset()]);
    put("items/Wardogs/Plugins/GameFeatures/Items/Buildables/Content/Data/LargeHammer/DT_Buildables_LargeHammer.json", [{ Type: "DataTable", Rows: { A: { Tag: { TagName: "Id.Buildable.Wall" } }, B: { Tag: { TagName: "Id.Buildable.Missing" } } } }]);
    put("items/Wardogs/Plugins/GameFeatures/Items/Buildables/Content/Data/SmallHammer/DT_Buildables_SmallHammer.json", [{ Type: "DataTable", Rows: { A: { Tag: { TagName: "Id.Buildable.Wall" } } } }]);
    const { files, notes } = buildFeaturesData(raw, "8");
    const buildables = BuildablesFile.parse(JSON.parse(files.find((f) => f.path === "data/buildables.json")!.content)).buildables;
    expect(buildables).toHaveLength(1);
    expect(buildables[0]!.tools).toEqual(["LargeHammer", "SmallHammer"]);
    expect(notes.join("\n")).toContain("Id.Buildable.Missing");
    LootFile.parse(JSON.parse(files.find((f) => f.path === "data/loot.json")!.content));
  });

  it("gives a buildable the icon its UI row names, case-insensitively, when the icon file was extracted", () => {
    const raw = mkdtempSync(join(tmpdir(), "wardogs-features-icon-"));
    const put = (path: string, value: unknown) => {
      mkdirSync(dirname(join(raw, path)), { recursive: true });
      writeFileSync(join(raw, path), typeof value === "string" ? value : JSON.stringify(value));
    };
    put("gameplay/Wardogs/Plugins/GameFeatures/Items/Buildables/Content/Data/Buildables/Wall/DA_Buildable_Wall.json", [asset()]);
    put("items/Wardogs/Plugins/GameFeatures/Items/Buildables/Content/Data/DT_EntityData_UI_Buildables.json", [
      { Type: "DataTable", Rows: { "ID.Buildable.Wall": { Icons: { FallbackIcon: { AssetPathName: "/Buildables/Wall/T_UI_Wall.T_UI_Wall" }, TaggedIcons: [] } } } },
    ]);
    const icon = () => BuildablesFile.parse(JSON.parse(buildFeaturesData(raw, "8").files.find((f) => f.path === "data/buildables.json")!.content)).buildables[0]!.icon;
    expect(icon()).toBeUndefined(); // the texture was not extracted
    put("icons/Buildables/Wall/T_UI_Wall.png", "png");
    expect(icon()).toBe("Buildables/Wall/T_UI_Wall.png");
  });
});

describe("buildables and loot: committed data", () => {
  const read = (name: string): unknown => JSON.parse(readFileSync(`data/${name}`, "utf8"));
  const { buildables } = BuildablesFile.parse(read("buildables.json"));
  const { tables } = LootFile.parse(read("loot.json"));
  const items = ItemsFile.parse(read("items.json")).items;
  const damage = DamageFile.parse(read("damage.json"));

  it("keeps both populated and sorted", () => {
    expect(buildables.length).toBeGreaterThanOrEqual(30);
    expect(tables.length).toBeGreaterThanOrEqual(10);
    for (const list of [buildables.map((b) => b.id), tables.map((t) => t.id)]) expect(list).toEqual([...list].sort((a, b) => a.localeCompare(b)));
  });

  it("links every buildable to damage rules that exist", () => {
    const entities = new Set(damage.rules.map((r) => r.entity));
    const missing = buildables.filter((b) => b.damageEntity && !entities.has(b.damageEntity)).map((b) => `${b.id}: ${b.damageEntity}`);
    // Buildables whose damage rules the game does not define (they take default damage).
    expect(missing.sort()).toEqual(missing.filter((m) => /Loudspeaker|MistralAA|Mortar|Phalanx|STN_05|Radio|FOB/.test(m)).sort());
  });

  it("only spawns items that exist in items.json", () => {
    const ids = new Set(items.map((i) => i.id.toLowerCase()));
    const missing = tables.flatMap((t) => t.items.flatMap((i) => [i.item, ...i.subItems.map((s) => s.item)])).filter((id) => !ids.has(id.toLowerCase()));
    // Items the game's loot tables name that have no definition in the game files (the "cheap" defibrillator was dropped, and so was `WEPN_023`).
    expect([...new Set(missing)].sort()).toEqual(["Id.Item.Defibrillator.Cheap", "Id.Item.WEPN_023"]);
  });

  it("gives most buildables an icon that is listed in the icon manifest", () => {
    const listed = new Set((JSON.parse(readFileSync("assets/icons.manifest.json", "utf8")) as { files: Array<{ path: string }> }).files.map((f) => f.path));
    expect(buildables.filter((b) => b.icon).length).toBeGreaterThanOrEqual(20);
    for (const b of buildables) if (b.icon) expect(listed.has(b.icon), b.id).toBe(true);
    expect(buildables.find((b) => b.id === "Id.Buildable.SandbagWall")?.icon).toBe("Buildables/Data/Buildables/SandbagWall/T_UI_Buildable_SandbagWall.png");
  });

  it("canaries: a sandbag wall costs 15 and has 735 health; a bunker costs 200 and has 5000", () => {
    const get = (id: string) => buildables.find((b) => b.id === id)!;
    expect(get("Id.Buildable.SandbagWall")).toMatchObject({ name: "Sandbag Wall", cost: 15, maxHealth: 735, maxStack: 100, damageEntity: "Buildable.SandbagWall" });
    expect(get("Id.Buildable.Bunker")).toMatchObject({ cost: 200, maxHealth: 5000, tools: ["LargeHammer"] });
    expect(get("Id.Buildable.Phalanx").cost).toBe(1200);
  });

  it("canaries: towers hold more loot than a single armor drop, and sniper-only tables respawn", () => {
    const get = (id: string) => tables.find((t) => t.id === id)!;
    expect(get("Tower").items.length).toBeGreaterThanOrEqual(5);
    expect(get("Tower")).toMatchObject({ spawnChance: 50, canRespawn: true, respawnTime: 300 });
    expect(get("Armor").items).toHaveLength(1);
    expect(get("SniperOnly.HighValue").canRespawn).toBe(true);
  });
});

describe("cosmetics", () => {
  const table = (struct: string, rows: unknown): RawExport[] => [{ Type: "DataTable", Properties: { RowStruct: { ObjectName: `Class'${struct}'` } } as never, Rows: rows as never }];

  it("parses skins with their set and archetype, and drops the tag prefixes", () => {
    const rows = parseCosmetics(
      "Season01_Skins",
      table("WDCosmeticData", {
        "Meta.Cosmetic.BlackAndGold.AK74": { EntityID: { TagName: "Id.Item.AK74M" }, Category: { TagName: "Meta.Cosmetic.BlackAndGold" }, Archetype: { TagName: "Item.Archetype.AR" } },
        "Meta.Cosmetic.Emote.Shh": { EntityID: { TagName: "Id.Emote.Shh" }, Category: { TagName: "Meta.Cosmetic.Emote" }, Archetype: { TagName: "None" } },
        "Meta.Cosmetic.Broken": { Category: { TagName: "Meta.Cosmetic.X" } },
      }),
    );
    expect(rows).toEqual([
      { id: "BlackAndGold.AK74", item: "Id.Item.AK74M", set: "BlackAndGold", archetype: "AR", source: "Season01_Skins" },
      { id: "Emote.Shh", item: "Id.Emote.Shh", set: "Emote", source: "Season01_Skins" },
    ]);
  });

  it("parses sets in collection order", () => {
    const sets = parseCosmeticSets(
      table("WDCosmeticSetData", {
        "Meta.Cosmetic.B": { Name: { LocalizedString: "B set" }, SortIndex: 2, bHideInCollection: true },
        "Meta.Cosmetic.A": { Name: { LocalizedString: "A set" }, SortIndex: 1 },
        "Meta.Cosmetic.Unnamed": { SortIndex: 0 },
      }),
    );
    expect(sets).toEqual([{ id: "A", name: "A set", sortIndex: 1, hidden: false }, { id: "B", name: "B set", sortIndex: 2, hidden: true }]);
  });

  it("committed data: every cosmetic's set has a name, weapon skins point at items, and Black & Gold exists", () => {
    const { sets, cosmetics } = CosmeticsFile.parse(JSON.parse(readFileSync("data/cosmetics.json", "utf8")));
    const items = new Set(ItemsFile.parse(JSON.parse(readFileSync("data/items.json", "utf8"))).items.map((i) => i.id.toLowerCase()));
    expect(cosmetics.length).toBeGreaterThanOrEqual(20);
    const named = new Set(sets.map((s) => s.id));
    // Taxi liveries and emotes are categories, not named sets.
    expect(cosmetics.filter((c) => !named.has(c.set) && !["Emote", "FactionLogo", "Taxi"].includes(c.set)).map((c) => c.id)).toEqual([]);
    expect(cosmetics.filter((c) => c.archetype && !items.has(c.item.toLowerCase())).map((c) => c.id)).toEqual([]);
    expect(sets.find((s) => s.id === "BlackAndGold")?.name).toBe("Black & Gold");
    expect(cosmetics.find((c) => c.id === "BlackAndGold.AK74")).toMatchObject({ item: "Id.Item.AK74M", archetype: "AR" });
  });
});

describe("tag text", () => {
  const table = (rows: unknown): RawExport[] => [{ Type: "DataTable", Properties: { RowStruct: { ObjectName: "Class'WDUIGameplayTagToTextTableRow'" } } as never, Rows: rows as never }];

  it("reads display text by tag, from localized or invariant strings, and skips rows without text", () => {
    const rows = parseTagTexts(
      "Archetypes",
      table({
        "Item.Archetype.AR": { Text: { LocalizedString: "Assault Rifle" }, Tag: { TagName: "Item.Archetype.AR" } },
        "Item.Attachment.Barrel": { Text: { CultureInvariantString: "BARREL" }, Tag: { TagName: "Item.Attachment.Barrel" } },
        "Item.Archetype.DMR": { Text: { SourceString: null, LocalizedString: "" }, Tag: { TagName: "Item.Archetype.DMR" } },
      }),
    );
    expect(rows).toEqual([
      { tag: "Item.Archetype.AR", text: "Assault Rifle", source: "Archetypes" },
      { tag: "Item.Attachment.Barrel", text: "BARREL", source: "Archetypes" },
    ]);
  });

  it("ignores tables of other row structs", () => {
    expect(parseTagTexts("X", [{ Type: "DataTable", Properties: { RowStruct: { ObjectName: "Class'Other'" } } as never, Rows: { a: { Text: { LocalizedString: "t" } } } as never }])).toEqual([]);
  });

  it("committed data: archetypes, roles and calibers have text, and weapon calibers resolve", () => {
    const { tags } = TagsFile.parse(JSON.parse(readFileSync("data/tags.json", "utf8")));
    const text = (tag: string) => tags.find((t) => t.tag === tag)?.text;
    expect(tags.length).toBeGreaterThanOrEqual(250);
    expect(text("Item.Archetype.AR")).toBe("Assault Rifle");
    expect(text("Meta.Role.Infantry")).toBe("ASSAULT"); // the game calls the Infantry role "Assault"
    expect(text("Item.Caliber.70mm")).toBe("70mm");
    expect(new Set(tags.map((t) => t.source)).size).toBeGreaterThanOrEqual(10);
    // Sorted by tag, then by source.
    for (let i = 1; i < tags.length; i++) {
      const [a, b] = [tags[i - 1]!, tags[i]!];
      expect(a.tag.localeCompare(b.tag) || a.source.localeCompare(b.source), `${a.tag} before ${b.tag}`).toBeLessThanOrEqual(0);
    }
  });
});
