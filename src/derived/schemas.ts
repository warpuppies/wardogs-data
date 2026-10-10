import { z, type ZodType } from "zod";
import { AmmoFile, AttachmentsFile, BuildablesFile, ChallengeRewardsFile, CosmeticsFile, DamageFile, EquipmentFile, LootFile, MetaFile, MovementFile, RewardsFile, RolesFile, SkillsFile, TagsFile, VehicleConfigsFile, VehiclesFile, WeaponsFile } from "../schema.gameplay.js";
import { BuildingsFile, ItemsFile, MapFile, ObjectivesFile, TerrainFile, WorldObjectsFile } from "../schema.js";

/** A published JSON file type: where it lives, what shape it has, and how to describe it. */
export interface PublishedSchema {
  /** Name of the schema file, `data/schema/<name>.schema.json`. */
  name: string;
  title: string;
  /** Paths of the data files with this shape. */
  match: RegExp;
  schema: ZodType;
}

/** Every JSON data file the pipeline publishes, with its schema. Adding a dataset means adding a line here. */
export const PUBLISHED: readonly PublishedSchema[] = [
  { name: "items", title: "Items and vehicles", match: /^data\/items\.json$/, schema: ItemsFile },
  { name: "ammo", title: "Ammunition ballistics", match: /^data\/ammo\.json$/, schema: AmmoFile },
  { name: "weapons", title: "Weapons", match: /^data\/weapons\.json$/, schema: WeaponsFile },
  { name: "attachments", title: "Attachments", match: /^data\/attachments\.json$/, schema: AttachmentsFile },
  { name: "equipment", title: "Equipment", match: /^data\/equipment\.json$/, schema: EquipmentFile },
  { name: "buildables", title: "Buildables", match: /^data\/buildables\.json$/, schema: BuildablesFile },
  { name: "tags", title: "Tag text", match: /^data\/tags\.json$/, schema: TagsFile },
  { name: "cosmetics", title: "Cosmetics", match: /^data\/cosmetics\.json$/, schema: CosmeticsFile },
  { name: "loot", title: "Loot tables", match: /^data\/loot\.json$/, schema: LootFile },
  { name: "movement", title: "Player movement", match: /^data\/movement\.json$/, schema: MovementFile },
  { name: "skills", title: "Role skills", match: /^data\/skills\.json$/, schema: SkillsFile },
  { name: "challenge-rewards", title: "Challenge rewards", match: /^data\/challenge-rewards\.json$/, schema: ChallengeRewardsFile },
  { name: "meta", title: "Meta game", match: /^data\/meta\.json$/, schema: MetaFile },
  { name: "roles", title: "Role levels", match: /^data\/roles\.json$/, schema: RolesFile },
  { name: "rewards", title: "Cash rewards", match: /^data\/rewards\.json$/, schema: RewardsFile },
  { name: "damage", title: "Damage model", match: /^data\/damage\.json$/, schema: DamageFile },
  { name: "vehicles", title: "Vehicle stats", match: /^data\/vehicles\.json$/, schema: VehiclesFile },
  { name: "vehicle-configs", title: "Vehicle configs", match: /^data\/vehicle-configs\.json$/, schema: VehicleConfigsFile },
  { name: "map", title: "Map metadata", match: /^data\/maps\/[^/]+\/map\.json$/, schema: MapFile },
  { name: "terrain", title: "Terrain heightmap metadata", match: /^data\/maps\/[^/]+\/terrain\.json$/, schema: TerrainFile },
  { name: "objectives", title: "Match objectives", match: /^data\/maps\/[^/]+\/objectives\.json$/, schema: ObjectivesFile },
  { name: "objects", title: "Placed gameplay objects", match: /^data\/maps\/[^/]+\/objects\.json$/, schema: WorldObjectsFile },
  { name: "buildings", title: "Buildings", match: /^data\/maps\/[^/]+\/buildings\.json$/, schema: BuildingsFile },
];

export const schemaPath = (name: string): string => `data/schema/${name}.schema.json`;

/** A JSON Schema (draft 2020-12) for what the files contain, titled and described from the zod definition. */
export function jsonSchemaFor(entry: PublishedSchema): Record<string, unknown> {
  const generated = z.toJSONSchema(entry.schema, { target: "draft-2020-12", io: "output" }) as Record<string, unknown>;
  const { $schema, ...rest } = generated;
  return { $schema, title: entry.title, ...rest };
}

export interface FieldDoc {
  /** Dotted path; `[]` marks list items, for example `items[].grid`. */
  path: string;
  type: string;
  required: boolean;
  description: string;
}

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | false;
  prefixItems?: JsonSchema[];
  anyOf?: JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  description?: string;
};

/** Short type name for a schema node: `string`, `integer`, `list of string`, `[number, number]`, `"a" | "b"`. */
export function typeName(node: JsonSchema): string {
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (node.enum) return node.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (node.anyOf) return node.anyOf.map(typeName).join(" or ");
  if (node.prefixItems) return `[${node.prefixItems.map(typeName).join(", ")}]`;
  if (node.type === "array") return node.items ? `list of ${typeName(node.items)}` : "list";
  if (node.type === "object") return "object";
  return Array.isArray(node.type) ? node.type.join(" or ") : (node.type ?? "any");
}

/** Flattens a JSON Schema into one row per field, depth first, in declaration order. */
export function fieldDocs(schema: JsonSchema, prefix = ""): FieldDoc[] {
  const rows: FieldDoc[] = [];
  const visit = (node: JsonSchema, path: string, required: boolean) => {
    const target = node.anyOf?.find((n) => n.type !== "null") ?? node; // look through `nullable`
    if (path && !path.endsWith("[]")) rows.push({ path, type: typeName(node), required, description: node.description ?? target.description ?? "" });
    if (target.properties) {
      for (const [key, child] of Object.entries(target.properties)) visit(child, path ? `${path}.${key}` : key, target.required?.includes(key) ?? false);
    } else if (target.type === "array" && target.items && typeof target.items === "object" && (target.items.properties || target.items.type === "array")) {
      visit({ ...target.items, description: "" }, `${path}[]`, true);
    }
  };
  visit(schema, prefix, true);
  return rows;
}
