import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ItemsFile } from "../src/schema.js";
import { buildItemsFile } from "../src/transform/build.js";

function write(root: string, rel: string, value: unknown): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

describe("buildItemsFile", () => {
  it("builds a valid items.json from a raw cache", () => {
    const root = mkdtempSync(join(tmpdir(), "wardogs-build-"));
    const raw = join(root, "raw");
    const out = join(root, "out");

    write(raw, "Wardogs/Content/Items/Test/ID_Widget.json", [
      { Type: "BHInventoryFragment_Stackable", Properties: { MaxStackSize: 4 } },
      { Type: "BHInventoryItemDefinition", Properties: { ItemId: { TagName: "Id.Item.Widget" }, DisplayName: { LocalizedString: "Widget" } } },
    ]);
    write(raw, "Wardogs/Content/Items/Test/ID_Widget_Audio.json", [{ Type: "WDAudioData" }]);
    write(raw, "Wardogs/Plugins/GameFeatures/Items/Widget/Content/Data/DT_VendorData_Ext_Widget.json", [
      { Type: "DataTable", Rows: { "Id.Item.Widget": { VendorItemVariations: [{ VariationTag: { TagName: "Id.Item.Widget" }, Price: 50, Amount: 1 }] } } },
    ]);
    // A per-vehicle market table living outside the vendor folder must still be picked up.
    write(raw, "Wardogs/Plugins/GameFeatures/Vehicles/V1/Content/DataTables/DT_VehicleMarket_V1.json", [
      { Type: "DataTable", Rows: { "Vehicle.Variant.Test": { VendorItemVariations: [{ Price: 9000 }] } } },
    ]);
    write(raw, "Wardogs/Content/Items/Test/ID_Truck.json", [
      { Type: "BHInventoryItemDefinition", Properties: { ItemId: { TagName: "Vehicle.Variant.Test" }, DisplayName: { LocalizedString: "Truck" } } },
    ]);

    const summary = buildItemsFile(raw, out, "42");
    expect(summary).toMatchObject({ items: 2, priced: 2, priceEntries: 2, orphans: [] });

    const parsed = ItemsFile.parse(JSON.parse(readFileSync(join(out, "items.json"), "utf8")));
    expect(parsed.gameBuild).toBe("42");
    expect(parsed.items.find((i) => i.id === "Id.Item.Widget")).toMatchObject({ maxStack: 4, vendor: [{ price: 50 }] });
    expect(parsed.items.find((i) => i.kind === "vehicle")?.vendor[0]?.price).toBe(9000);
  });

  it("is deterministic", () => {
    const root = mkdtempSync(join(tmpdir(), "wardogs-det-"));
    const raw = join(root, "raw");
    write(raw, "Wardogs/ID_A.json", [{ Type: "BHInventoryItemDefinition", Properties: { ItemId: { TagName: "Id.Item.A" }, DisplayName: { LocalizedString: "A" } } }]);
    buildItemsFile(raw, join(root, "one"), "1");
    buildItemsFile(raw, join(root, "two"), "1");
    expect(readFileSync(join(root, "one", "items.json"), "utf8")).toBe(readFileSync(join(root, "two", "items.json"), "utf8"));
  });
});
