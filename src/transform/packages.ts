import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RawExport } from "./items.js";

/**
 * Finds decoded packages by the object paths the game uses to refer to them. The cache holds one JSON file per
 * package under `Wardogs/Content/...` (mounted as `/Game/...`) and `Wardogs/Plugins/.../<Plugin>/Content/...`
 * (mounted as `/<Plugin>/...`). An object path looks like `/WEPN_001/Data/DA_AK74M_Stats.0`: the package path, a dot
 * and the export index, or `Class'Name'` style text that ends the same way.
 */
export class PackageIndex {
  private readonly files = new Map<string, { file: string; asset: string }>();
  private readonly cache = new Map<string, RawExport[]>();

  /** Indexes every `.json` package below the given cache folders. */
  constructor(roots: string[]) {
    for (const root of roots) this.add(root, root);
  }

  private add(root: string, dir: string): void {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) this.add(root, full);
      else if (name.endsWith(".json") && !name.startsWith("_")) {
        const key = packageKey(full.slice(root.length).replaceAll("\\", "/"));
        if (key) this.files.set(key.toLowerCase(), { file: full, asset: assetPath(full.slice(root.length).replaceAll("\\", "/")) });
      }
    }
  }

  /** The decoded exports of the package an object path points into, or undefined when it is not in the cache. */
  load(objectPath: string | undefined | null): RawExport[] | undefined {
    if (!objectPath) return undefined;
    const key = objectPath.replace(/\.[^./]*$/, "").toLowerCase();
    const entry = this.files.get(key);
    if (!entry) return undefined;
    let exports = this.cache.get(entry.file);
    if (!exports) {
      exports = JSON.parse(readFileSync(entry.file, "utf8")) as RawExport[];
      this.cache.set(entry.file, exports);
    }
    return exports;
  }

  /** Path of the package an object path points into, relative to the game's content root, or undefined. */
  asset(objectPath: string | undefined | null): string | undefined {
    return objectPath ? this.files.get(objectPath.replace(/\.[^./]*$/, "").toLowerCase())?.asset : undefined;
  }

  /**
   * Every export of a given type (a name, or a pattern for the type name) in every indexed package, with the package's path, in a stable order. Packages
   * are read one at a time and not kept in memory.
   */
  *findAll(type: string | RegExp, namePrefix = ""): Generator<{ asset: string; export: RawExport }> {
    for (const key of [...this.files.keys()].sort()) {
      const entry = this.files.get(key)!;
      if (!entry.file.split(/[\\/]/).pop()!.startsWith(namePrefix)) continue;
      const exports = JSON.parse(readFileSync(entry.file, "utf8")) as RawExport[];
      for (const exp of exports) if (typeof type === "string" ? exp.Type === type : type.test(exp.Type)) yield { asset: entry.asset, export: exp };
    }
  }

  /** The first export of a given type in the package an object path points into. */
  loadExport(objectPath: string | undefined | null, type: string): RawExport | undefined {
    return this.load(objectPath)?.find((e) => e.Type === type);
  }

  get size(): number {
    return this.files.size;
  }
}

/** Package path (`/Game/...` or `/<Plugin>/...`) of a cached file path relative to its root, or null if it is neither. */
export function packageKey(relative: string): string | null {
  const path = relative.replace(/^\/+/, "").replace(/\.json$/, "");
  const game = /^Wardogs\/Content\/(.+)$/.exec(path);
  if (game) return `/Game/${game[1]}`;
  const plugin = /^Wardogs\/Plugins\/(?:.+\/)?([^/]+)\/Content\/(.+)$/.exec(path);
  return plugin ? `/${plugin[1]}/${plugin[2]}` : null;
}

/** Path of a cached file relative to the game's content root (`Content/...` or `Plugins/...`), without extension. */
export function assetPath(relative: string): string {
  return relative.replace(/^\/+/, "").replace(/^Wardogs\//, "").replace(/\.json$/, "");
}
