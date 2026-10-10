import type { GeneratedFile } from "../generated.js";
import { buildCsvTables, type JsonFiles } from "./csv.js";
import { buildDictionary } from "./dictionary.js";
import { jsonSchemaFor, PUBLISHED, schemaPath } from "./schemas.js";

const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";

/**
 * Files derived from the generated data files: one JSON Schema per published shape, the CSV tables, and the data
 * dictionary. Pure: the same data files always give the same output.
 */
export function deriveFiles(files: readonly GeneratedFile[]): GeneratedFile[] {
  const parsed: JsonFiles = new Map(files.filter((f) => f.path.endsWith(".json") && PUBLISHED.some((p) => p.match.test(f.path))).map((f) => [f.path, JSON.parse(f.content) as unknown]));
  const dataPaths = files.map((f) => f.path);

  const derived: GeneratedFile[] = [];
  for (const entry of PUBLISHED) {
    if (dataPaths.some((p) => entry.match.test(p))) derived.push({ path: schemaPath(entry.name), content: json(jsonSchemaFor(entry)) });
  }
  const csv = buildCsvTables(parsed);
  for (const t of csv) derived.push({ path: t.path, content: t.content });

  const items = parsed.get("data/items.json") as { gameBuild?: string } | undefined;
  derived.push({ path: "data/README.md", content: buildDictionary(dataPaths, csv, items?.gameBuild ?? "unknown") });
  return derived;
}
