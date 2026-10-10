import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { iconFilePath, parseUiTable, type RawExport, type UiText } from "./items.js";

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

/**
 * The name and icon the UI tables (`DT_EntityData_UI*`) give to each id, keyed by the lowercase id because the game
 * writes the same id as `Id.` and `ID.`. An icon counts only when its file was extracted (`iconsDir`); a row can name a
 * texture that is not in the game files. Plugin tables are read after the shared ones, so the more specific row wins.
 */
export function readUiIcons(itemsDir: string, iconsDir: string): Map<string, { name?: string; icon?: string }> {
  const files = [...walk(itemsDir)].filter((f) => /[\\/]DT_EntityData_UI[^\\/]*\.json$/.test(f));
  const plugin = (f: string) => /[\\/]Plugins[\\/]/.test(f);
  const out = new Map<string, { name?: string; icon?: string }>();
  for (const file of [...files.filter((f) => !plugin(f)), ...files.filter(plugin)]) {
    for (const [id, text] of parseUiTable(JSON.parse(readFileSync(file, "utf8")) as RawExport[]) as Map<string, UiText>) {
      const path = text.icon ? iconFilePath(text.icon) : undefined;
      const icon = path && existsSync(join(iconsDir, path)) ? path : undefined;
      const entry = { ...(text.name ? { name: text.name } : {}), ...(icon ? { icon } : {}) };
      if (Object.keys(entry).length) out.set(id.toLowerCase(), { ...out.get(id.toLowerCase()), ...entry });
    }
  }
  return out;
}
