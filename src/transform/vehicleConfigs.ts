import type { VehicleConfig, VehicleConfigAsset, VehicleConfigExport } from "../schema.gameplay.js";
import type { PropertyValue } from "../schema.gameplay.js";
import type { RawExport } from "./items.js";
import type { PackageIndex } from "./packages.js";

type Props = Record<string, any>; // decoded game properties: walked generically below

/** Config classes by family. A new `*VehicleConfigDataAsset` class is reported by `collectVehicleConfigs`, not skipped. */
const FAMILIES: Readonly<Record<string, VehicleConfig["family"]>> = {
  MWheeledVehicleConfigDataAsset: "wheeled",
  MTrackedVehicleConfigDataAsset: "tracked",
  BHRotaryVehicleConfigDataAsset: "rotary",
  BHBaseVehicleConfigDataAsset: "stationary",
  BHAirplaneVehicleConfigDataAsset: "airplane",
};

/** What a variant id of each family starts with after `Vehicle.Variant.`. The game's data reuses damage entities across families (the airplane's systems asset carries the Little Bird's), so the entity alone is not enough to attribute a config. */
const VARIANT_PREFIX: Readonly<Record<VehicleConfig["family"], string>> = {
  wheeled: "Vehicle.Variant.Land.Wheeled.",
  tracked: "Vehicle.Variant.Land.Tracked.",
  rotary: "Vehicle.Variant.Air.Rotary.",
  airplane: "Vehicle.Variant.Air.Airplane.",
  stationary: "Vehicle.Variant.Stationary.",
};

/**
 * Classes that are art or audio content rather than properties: meshes and their collision, MetaSound graphs, particle
 * systems, materials and textures. A package holding one is listed in `skipped` and not published, and its own
 * references are not followed.
 */
export const SKIPPED_TYPES = /^(MetaSoundSource|StaticMesh|SkeletalMesh|BodySetup|NavCollision|PhysicsAsset|Skeleton|SoundWave|Niagara.*|Material.*|Texture.*)$/;

/** Code-unit order, which does not depend on the machine's locale. */
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Package path of an object path (`/WHL_05/Data/DA_X.4` is `/WHL_05/Data/DA_X`); engine classes (`/Script/...`) are not assets. */
const packageOf = (objectPath: string): string | undefined => (objectPath.startsWith("/Script/") ? undefined : objectPath.replace(/\.[^./]*$/, ""));

/** The name of the object inside its package from an `ObjectName` such as `Class'Package:Sub_0'`, when it names one. */
const subObject = (objectName: unknown): string | undefined => {
  const inner = /'([^']*)'$/.exec(String(objectName ?? ""))?.[1];
  const sub = inner?.includes(":") ? inner.split(":").pop() : undefined;
  return sub || undefined;
};

const isRef = (v: Props): boolean => typeof v.ObjectPath === "string";

/** Every package path a decoded value refers to, in order of appearance. */
function* references(v: unknown): Generator<string> {
  if (Array.isArray(v)) for (const x of v) yield* references(x);
  else if (v && typeof v === "object") {
    if (isRef(v as Props)) {
      const pkg = packageOf((v as Props).ObjectPath);
      if (pkg) yield pkg;
    } else for (const x of Object.values(v)) yield* references(x);
  }
}

/**
 * Turns decoded game values into plain JSON: object references become `{ ref, object? }`, gameplay tags `{ tag }` and
 * text `{ text, table?, key? }` (the string table entry it came from). Everything else, including property names and numbers, is kept as the game wrote it.
 */
export function normalizeValue(v: unknown): PropertyValue {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map(normalizeValue);
  if (typeof v !== "object") return v as PropertyValue;
  const o = v as Props;
  if (isRef(o)) {
    const pkg = o.ObjectPath === "" ? undefined : packageOf(o.ObjectPath);
    if (!pkg) return o.ObjectPath === "" || o.ObjectName === "None" ? null : { ref: String(o.ObjectPath) };
    const object = subObject(o.ObjectName);
    return object ? { ref: pkg, object } : { ref: pkg };
  }
  if ("TagName" in o && Object.keys(o).length === 1) return o.TagName === "None" ? null : { tag: String(o.TagName) };
  if ("LocalizedString" in o || "SourceString" in o || "CultureInvariantString" in o) {
    const raw = o.LocalizedString ?? o.SourceString ?? o.CultureInvariantString;
    const text = typeof raw === "string" ? raw.replace(/\r\n?/g, "\n").trim() : null;
    return { text, ...(typeof o.TableId === "string" ? { table: o.TableId } : {}), ...(typeof o.Key === "string" ? { key: o.Key } : {}) };
  }
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, normalizeValue(x)]));
}

export function normalizeExport(exp: RawExport): VehicleConfigExport {
  const outer = subObject(exp.Outer?.ObjectName) ?? /'([^':]*)'$/.exec(exp.Outer?.ObjectName ?? "")?.[1];
  const out: VehicleConfigExport = { name: exp.Name ?? exp.Type, type: exp.Type, properties: normalizeValue(exp.Properties ?? {}) as Record<string, PropertyValue> };
  return outer ? { ...out, outer } : out;
}

export interface VehicleConfigsBuild {
  configs: VehicleConfig[];
  assets: VehicleConfigAsset[];
  unresolved: string[];
  skipped: { package: string; types: string[] }[];
}

/**
 * Finds every vehicle config asset and follows its references, package by package, through everything the cache
 * holds. `entityOf` gives the damage entity of a gameplay systems asset package (and undefined for others) and
 * `variantsOf` the variants that use an entity.
 */
export function collectVehicleConfigs(
  index: Pick<PackageIndex, "load" | "asset" | "findAll">,
  entityOf: (systemsPackage: string) => string | undefined,
  variantsOf: (entity: string) => string[],
): VehicleConfigsBuild {
  const assets = new Map<string, VehicleConfigAsset>(); // by lower-case package path
  const unresolved = new Map<string, string>(); // by lower-case package path
  const skipped = new Map<string, { package: string; types: string[] }>(); // by lower-case package path
  const key = (pkg: string): string => pkg.toLowerCase();

  /** Reads a package once and returns the packages it refers to. */
  const visit = (pkg: string): string[] | undefined => {
    const exports = index.load(pkg);
    if (!exports) return undefined;
    if (exports.some((e) => SKIPPED_TYPES.test(e.Type))) {
      skipped.set(key(pkg), { package: exports[0]?.Package ?? pkg, types: [...new Set(exports.map((e) => e.Type))].sort(compare) });
      return [];
    }
    if (!assets.has(key(pkg))) {
      assets.set(key(pkg), { package: exports[0]?.Package ?? pkg, asset: index.asset(pkg) ?? pkg, exports: exports.map(normalizeExport) });
    }
    return [...references(exports.map((e) => e.Properties))];
  };

  const configs: VehicleConfig[] = [];
  const configRe = /VehicleConfigDataAsset$/;
  const found: { package: string; exp: RawExport }[] = [];
  for (const { export: exp } of index.findAll(configRe)) {
    const pkg = exp.Package;
    if (pkg) found.push({ package: pkg, exp });
  }
  for (const { package: pkg, exp } of found.sort((a, b) => compare(a.package, b.package))) {
    const family = FAMILIES[exp.Type];
    if (!family) throw new Error(`Unknown vehicle config class ${exp.Type} in ${pkg}: add it to FAMILIES in src/transform/vehicleConfigs.ts.`);
    const reached = new Set<string>();
    const queue = [pkg];
    while (queue.length) {
      const next = queue.shift()!;
      if (reached.has(key(next))) continue;
      const refs = visit(next);
      if (!refs) {
        if (!unresolved.has(key(next))) unresolved.set(key(next), next);
        continue;
      }
      if (!skipped.has(key(next))) reached.add(key(next));
      queue.push(...refs);
    }
    const systems = (exp.Properties?.GameplayConfigDataAsset as Props | undefined)?.ObjectPath;
    const entity = typeof systems === "string" && packageOf(systems) ? entityOf(packageOf(systems)!) : undefined;
    configs.push({
      package: pkg,
      type: exp.Type,
      family,
      ...(entity ? { damageEntity: entity } : {}),
      variants: entity ? variantsOf(entity).filter((id) => id.toLowerCase().startsWith(VARIANT_PREFIX[family].toLowerCase())) : [],
      assets: [...reached].map((k) => assets.get(k)!.package).sort(compare),
    });
  }
  return {
    configs,
    assets: [...assets.values()].sort((a, b) => compare(a.package, b.package)),
    unresolved: [...unresolved.values()].sort(compare),
    skipped: [...skipped.values()].sort((a, b) => compare(a.package, b.package)),
  };
}
