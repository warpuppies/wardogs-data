import { describe, expect, it } from "vitest";
import {
  buildItems,
  DEFAULT_MAX_STACK,
  iconFilePath,
  mergeUiTables,
  parseItemDefinition,
  parseUiTable,
  pickIcon,
  parseUnlockTree,
  parseVendorTable,
  type RawExport,
} from "../src/transform/items.js";

const definition = (id: string, name: string, fragments: RawExport[] = []): RawExport[] => [
  {
    Type: "BHInventoryItemDefinition",
    Properties: { ItemId: { TagName: id }, DisplayName: { LocalizedString: name }, ItemContext: ["Item.Test"] },
  },
  ...fragments,
];

describe("parseItemDefinition", () => {
  it("defaults to a 1x1 item that does not stack", () => {
    const item = parseItemDefinition(definition("Id.Item.Plain", "Plain Thing"), "Items/ID_Plain");
    expect(item).toMatchObject({ id: "Id.Item.Plain", kind: "item", name: "Plain Thing", grid: [1, 1], maxStack: 1 });
  });

  it("reads grid, stack, weight and durability from fragments", () => {
    const item = parseItemDefinition(
      definition("Id.Item.Full", "Full Thing", [
        { Type: "BHInventoryFragment_CustomShape", Properties: { Dimensions: { X: 2, Y: 3 } } },
        { Type: "BHInventoryFragment_Stackable", Properties: { MaxStackSize: 5 } },
        { Type: "BHInventoryFragment_Weight", Properties: { Weight: 0.25 } },
        { Type: "WDInventoryFragment_Durability", Properties: { ReplicatedData: { Durability: 3000 } } },
      ]),
      "Items/ID_Full",
    );
    expect(item).toMatchObject({ grid: [2, 3], maxStack: 5, weight: 0.25, durability: 3000 });
  });

  it("treats a Stackable fragment without a value as the class default", () => {
    // The engine omits properties equal to the default, so an empty fragment means DEFAULT_MAX_STACK.
    const item = parseItemDefinition(
      definition("Id.Item.Kit", "Kit", [{ Type: "BHInventoryFragment_Stackable" }]),
      "Items/ID_Kit",
    );
    expect(item?.maxStack).toBe(DEFAULT_MAX_STACK);
  });

  it("trims padded display names", () => {
    const item = parseItemDefinition(definition("Id.Item.Pad", ".308 "), "Items/ID_Pad");
    expect(item?.name).toBe(".308");
  });

  it("classifies vehicle ids", () => {
    const item = parseItemDefinition(definition("Vehicle.Variant.Ground.Test.Default", "Test Truck"), "Vehicles/ID_Truck");
    expect(item?.kind).toBe("vehicle");
  });

  it("ignores packages that are not item definitions", () => {
    expect(parseItemDefinition([{ Type: "WDAudioData" }], "Audio/ID_Thing_Audio")).toBeNull();
    expect(parseItemDefinition([{ Type: "BHInventoryItemDefinition", Properties: {} }], "x")).toBeNull();
  });
});

const vendorTable = (rows: Record<string, unknown>): RawExport[] => [{ Type: "DataTable", Rows: rows as RawExport["Rows"] }];

describe("parseVendorTable", () => {
  it("flattens variations and skips entries without a price", () => {
    const entries = parseVendorTable(
      vendorTable({
        "Id.Item.A": {
          VendorItemVariations: [
            { VariationTag: { TagName: "Id.Item.A" }, Price: 400, Amount: 1, Categories: ["Vendor.Category.Gear"] },
            { VariationTag: { TagName: "Id.Item.A.Broken" } },
          ],
        },
      }),
    );
    expect(entries).toEqual([
      { rowId: "Id.Item.A", variation: { tag: "Id.Item.A", price: 400, amount: 1, categories: ["Vendor.Category.Gear"] } },
    ]);
  });

  it("returns nothing for non-table exports and empty tables", () => {
    expect(parseVendorTable([{ Type: "Other" }])).toEqual([]);
    expect(parseVendorTable(vendorTable({}))).toEqual([]);
  });
});

describe("buildItems", () => {
  const defs = [
    parseItemDefinition(definition("Id.Item.B", "B Item"), "b")!,
    parseItemDefinition(definition("Id.Item.A", "A Item"), "a")!,
  ];
  const entry = (rowId: string, tag: string, price: number) => ({
    rowId,
    variation: { tag, price, amount: 1, categories: [] },
  });

  it("joins prices onto items and sorts by id", () => {
    const { items } = buildItems(defs, [entry("Id.Item.B", "Id.Item.B", 10), entry("Id.Item.A", "Id.Item.A", 20)]);
    expect(items.map((i) => i.id)).toEqual(["Id.Item.A", "Id.Item.B"]);
    expect(items[0]?.vendor[0]?.price).toBe(20);
  });

  it("removes entries repeated across vendor tables", () => {
    const { items } = buildItems(defs, [entry("Id.Item.A", "Id.Item.A", 20), entry("Id.Item.A", "Id.Item.A", 20)]);
    expect(items[0]?.vendor).toHaveLength(1);
  });

  it("matches ids without regard to case, as the game's tags do, and keeps the definition's casing", () => {
    const def = parseItemDefinition(definition("ID.Item.Smoke.White", "Smoke"), "s")!;
    const ui = new Map([["id.item.smoke.white", { name: "Smoke Grenade: White", icon: "/Game/UI/Icons/T_Smoke", subtitle: "Grenade", description: "d" }]]);
    const unlocks = new Map([["Id.Item.Smoke.White", { role: "Support", level: 3, cost: 100 }]]);
    const { items, orphans, unlockOrphans } = buildItems([def], [entry("Id.Item.Smoke.White", "Id.Item.Smoke.White", 7), entry("Id.Item.Smoke.White.Variant", "Id.Item.Smoke.White.Variant", 8)], unlocks, ui);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "ID.Item.Smoke.White", unlock: { role: "Support", level: 3, cost: 100 }, icon: "UI/Icons/T_Smoke.png", subtitle: "Grenade", description: "d" });
    expect(items[0]?.vendor.map((v) => v.price)).toEqual([7, 8]);
    expect([orphans, unlockOrphans]).toEqual([[], []]);
  });

  it("attaches variation rows to the base item and reports orphans", () => {
    const { items, orphans } = buildItems(defs, [entry("Id.Item.A.Variant", "Id.Item.A.Variant", 5), entry("Id.Item.Missing", "Id.Item.Missing", 1)]);
    expect(items[0]?.vendor.map((v) => v.tag)).toEqual(["Id.Item.A.Variant"]);
    expect(orphans).toEqual(["Id.Item.Missing"]);
  });
});

const treeNode = (id: string, minLevel: number, cost: number, roleTag?: string) => ({
  ID: { TagName: id },
  LevelsData: [
    {
      Prerequisites: { QueryDefinition: { SharedDefinition: { Conditions: { Structs: [{ MinLevel: minLevel, ...(roleTag ? { MetaId: { TagName: roleTag } } : {}) }] } } } },
      Cost: [{ Key: { TagName: "Attribute.Meta.Currency.Cash" }, Value: cost }],
    },
  ],
});
const tree = (rows: Record<string, unknown[]>): RawExport[] => [
  { Type: "DataTable", Rows: Object.fromEntries(Object.entries(rows).map(([k, Nodes]) => [k, { Nodes }])) as unknown as RawExport["Rows"] },
];

describe("parseUnlockTree", () => {
  it("reads role, minimum level and cash cost", () => {
    const unlocks = parseUnlockTree(tree({ "Meta.Role.Infantry": [treeNode("Id.Item.Rifle", 3, 10000, "Meta.Role.Infantry")] }));
    expect(unlocks.get("Id.Item.Rifle")).toEqual({ role: "Infantry", level: 3, cost: 10000 });
  });

  it("names the career tree after its row, since its conditions carry no role", () => {
    const unlocks = parseUnlockTree(tree({ "Meta.Role.Wardog": [treeNode("Id.Item.Pistol", 1, 5000)] }));
    expect(unlocks.get("Id.Item.Pistol")).toEqual({ role: "Wardog", level: 1, cost: 5000 });
  });

  it("skips nodes without a usable level and tolerates empty input", () => {
    expect(parseUnlockTree(tree({ "Meta.Role.Medic": [{ ID: { TagName: "Id.Item.X" }, LevelsData: [] }] })).size).toBe(0);
    expect(parseUnlockTree([{ Type: "Other" }]).size).toBe(0);
  });

  it("attaches unlocks to items and reports ids with no definition", () => {
    const def = parseItemDefinition(definition("Id.Item.Rifle", "Rifle"), "r")!;
    const unlocks = parseUnlockTree(tree({ "Meta.Role.Infantry": [treeNode("Id.Item.Rifle", 3, 10000), treeNode("Id.Item.Ghost", 2, 1)] }));
    const { items, unlockOrphans } = buildItems([def], [], unlocks);
    expect(items[0]?.unlock).toEqual({ role: "Infantry", level: 3, cost: 10000 });
    expect(unlockOrphans).toEqual(["Id.Item.Ghost"]);
  });

  it("leaves unlock null for items outside the trees", () => {
    const def = parseItemDefinition(definition("Id.Item.Free", "Free"), "f")!;
    expect(buildItems([def], []).items[0]?.unlock).toBeNull();
  });
});

const uiTable = (rows: Record<string, unknown>): RawExport[] => [{ Type: "DataTable", Rows: rows as RawExport["Rows"] }];
const text = (value: string) => ({ LocalizedString: value, SourceString: value });

describe("parseUiTable", () => {
  it("reads name, subtitle and description, normalizing line breaks", () => {
    const ui = parseUiTable(
      uiTable({
        "Id.Item.Gun": {
          FriendlyName: text("Gun "),
          Description: text("- Semi\r\n- 5.45x39mm"),
          AdditionalTexts: [{ Key: { TagName: "UI.Tooltip.Layout.ItemSubtitle" }, Value: text("Assault Rifle") }],
        },
      }),
    );
    expect(ui.get("Id.Item.Gun")).toEqual({ name: "Gun", subtitle: "Assault Rifle", description: "- Semi\n- 5.45x39mm" });
  });

  it("falls back to the tooltip description and to culture-invariant names", () => {
    const ui = parseUiTable(
      uiTable({
        "Id.Item.Ammo": {
          FriendlyName: { CultureInvariantString: "Ammo: 1" },
          Description: { CultureInvariantString: null },
          AdditionalTexts: [{ Key: { TagName: "UI.Tooltip.Layout.ItemDescription" }, Value: text("Stack of rounds") }],
        },
      }),
    );
    expect(ui.get("Id.Item.Ammo")).toEqual({ name: "Ammo: 1", description: "Stack of rounds" });
  });

  it("does not read the flavor text", () => {
    const ui = parseUiTable(
      uiTable({
        "Id.Item.Gun": {
          FriendlyName: text("Gun"),
          AdditionalTexts: [{ Key: { TagName: "UI.Tooltip.Layout.ItemFlavor" }, Value: text("A story.") }],
        },
      }),
    );
    expect(ui.get("Id.Item.Gun")).toEqual({ name: "Gun" });
  });

  it("skips rows with no text and non-table exports", () => {
    expect(parseUiTable(uiTable({ "Id.Item.Empty": { FriendlyName: { CultureInvariantString: null } } })).size).toBe(0);
    expect(parseUiTable([{ Type: "WDAudioData" }]).size).toBe(0);
  });
});

describe("mergeUiTables", () => {
  it("keeps the first table's whole row when the names differ, and reports it", () => {
    const first = new Map([["Id.A", { name: "Ural" }], ["Id.B", { name: "Same", description: "x" }]]);
    const second = new Map([["Id.A", { name: "Ural Truck", description: "Truck" }], ["Id.B", { name: "Same", description: "x" }], ["Id.C", { name: "C" }]]);
    const { ui, conflicts } = mergeUiTables([first, second]);
    expect(ui.get("Id.A")).toEqual({ name: "Ural" });
    expect(ui.get("Id.C")).toEqual({ name: "C" });
    expect(conflicts).toEqual(["Id.A"]);
  });

  it("fills fields the winner lacks from a row with the same name", () => {
    const feature = new Map([["Id.Gun", { name: "Judge", icon: "/Game/Icons/Gun" }]]);
    const shared = new Map([["Id.Gun", { name: "judge", icon: "/Game/Icons/Other", description: "- Double-action" }]]);
    const { ui, conflicts } = mergeUiTables([feature, shared]);
    expect(ui.get("Id.Gun")).toEqual({ name: "Judge", icon: "/Game/Icons/Gun", description: "- Double-action" });
    expect(conflicts).toEqual(["Id.Gun"]); // the icons differ
  });

  it("treats ids that differ only in case as one id", () => {
    const first = new Map([["Id.Gun", { name: "Judge", icon: "/Game/Icons/Gun" }]]);
    const second = new Map([["ID.Gun", { name: "Judge", description: "d" }]]);
    const { ui, conflicts } = mergeUiTables([first, second]);
    expect([...ui.keys()]).toEqual(["Id.Gun"]);
    expect(ui.get("Id.Gun")).toEqual({ name: "Judge", icon: "/Game/Icons/Gun", description: "d" });
    expect(conflicts).toEqual([]);
  });

  it("does not modify its inputs", () => {
    const first = new Map([["Id.A", { name: "A" }]]);
    mergeUiTables([first, new Map([["Id.A", { name: "A", description: "d" }]])]);
    expect(first.get("Id.A")).toEqual({ name: "A" });
  });
});

describe("buildItems with UI text", () => {
  const base = (id: string, name: string) => ({ id, kind: "item" as const, asset: `X/${id}`, name, tags: [], grid: [1, 1] as [number, number], maxStack: 1 });

  it("names items that only had their id, but never overrides a real name", () => {
    const ui = new Map([
      ["Vehicle.Truck", { name: "Truck", subtitle: "Truck", description: "Big" }],
      ["Id.Item.Real", { name: "Shop Name" }],
    ]);
    const { items } = buildItems([base("Vehicle.Truck", "Vehicle.Truck"), base("Id.Item.Real", "Real Name")], [], new Map(), ui);
    expect(items.find((i) => i.id === "Vehicle.Truck")).toMatchObject({ name: "Truck", subtitle: "Truck", description: "Big" });
    expect(items.find((i) => i.id === "Id.Item.Real")?.name).toBe("Real Name");
  });

  it("leaves text fields out when there is nothing to say", () => {
    const { items } = buildItems([base("Id.Item.Plain", "Plain")], []);
    expect(items[0]).not.toHaveProperty("subtitle");
    expect(items[0]).not.toHaveProperty("description");
  });
});

describe("pickIcon", () => {
  const tagged = (key: string, ...usages: string[]) => ({ Key: key, Value: usages });

  it("prefers the inventory icon over shop, killfeed and the row's fallback", () => {
    const icons = {
      FallbackIcon: { AssetPathName: "/Game/Killfeed" },
      TaggedIcons: [
        tagged("/Game/Killfeed", "UI.Icon.Killfeed"),
        tagged("/Game/Shop", "UI.Icon.Vendor"),
        tagged("/Game/Grid", "UI.Icon.Vendor", "UI.Icon.Inventory.Container"),
      ],
    };
    expect(pickIcon(icons)).toBe("/Game/Grid");
  });

  it("falls back through shop, then equipment, then the fallback icon", () => {
    expect(pickIcon({ TaggedIcons: [tagged("/Game/Eq", "UI.Icon.Inventory.Equipment"), tagged("/Game/Shop", "UI.Icon.Vendor")] })).toBe("/Game/Shop");
    expect(pickIcon({ TaggedIcons: [tagged("/Game/Eq", "UI.Icon.Inventory.Equipment")] })).toBe("/Game/Eq");
    expect(pickIcon({ FallbackIcon: { AssetPathName: "/Game/Only" }, TaggedIcons: [tagged("/Game/Map", "UI.Icon.Tracker.TacticalMap")] })).toBe("/Game/Only");
  });

  it("returns nothing when there is no usable icon", () => {
    expect(pickIcon(undefined)).toBeUndefined();
    expect(pickIcon({ FallbackIcon: { AssetPathName: "" }, TaggedIcons: [] })).toBeUndefined();
  });
});

describe("iconFilePath", () => {
  it("drops the game root and the object suffix", () => {
    expect(iconFilePath("/Game/UI/Shared/Icons/T_A.T_A")).toBe("UI/Shared/Icons/T_A.png");
  });

  it("keeps the plugin name for feature plugins", () => {
    expect(iconFilePath("/TNK_01/Textures/T_B.T_B")).toBe("TNK_01/Textures/T_B.png");
  });

  it("keeps same-named textures in different folders apart", () => {
    expect(iconFilePath("/Game/Ammo/T_Box.T_Box")).not.toBe(iconFilePath("/Game/Ammo/Tracer/T_Box.T_Box"));
  });
});

describe("parseUiTable icons and buildItems", () => {
  const icons = { TaggedIcons: [{ Key: "/Game/UI/Icons/T_Gun.T_Gun", Value: ["UI.Icon.Inventory.Container"] }] };
  const base = (id: string) => ({ id, kind: "item" as const, asset: `X/${id}`, name: id, tags: [], grid: [1, 1] as [number, number], maxStack: 1 });

  it("reads the chosen icon texture", () => {
    expect(parseUiTable(uiTable({ "Id.Item.Gun": { Icons: icons } })).get("Id.Item.Gun")).toEqual({ icon: "/Game/UI/Icons/T_Gun.T_Gun" });
  });

  it("sets the icon file on the item, and leaves it out when the file was not extracted", () => {
    const ui = new Map([["Id.Item.Gun", { icon: "/Game/UI/Icons/T_Gun.T_Gun" }]]);
    expect(buildItems([base("Id.Item.Gun")], [], new Map(), ui).items[0]?.icon).toBe("UI/Icons/T_Gun.png");
    expect(buildItems([base("Id.Item.Gun")], [], new Map(), ui, () => false).items[0]).not.toHaveProperty("icon");
  });
});
