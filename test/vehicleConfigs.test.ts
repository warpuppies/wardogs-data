import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VehicleConfigsFile, VehiclesFile } from "../src/schema.gameplay.js";
import type { RawExport } from "../src/transform/items.js";
import { PackageIndex } from "../src/transform/packages.js";
import { packagesPattern } from "../src/extract/linked.js";
import { collectVehicleConfigs, normalizeExport, normalizeValue } from "../src/transform/vehicleConfigs.js";

const ref = (path: string, name?: string) => ({ ObjectName: name ?? `Thing'${path.split("/").pop()}'`, ObjectPath: `${path}.0` });

describe("normalizeValue", () => {
  it("turns references, tags and text into plain values and keeps everything else as written", () => {
    expect(
      normalizeValue({
        Mass: 7250,
        bFlag: true,
        Mode: "EMSuspensionQueryType::Convex",
        Asset: ref("/WHL_05/Data/DA_X"),
        Sub: { ObjectName: "Eff_C'DA_Stats:Eff_C_0'", ObjectPath: "/WHL_05/Data/DA_Stats.4" },
        Engine: { ObjectName: "Class'/Script/Engine'", ObjectPath: "/Script/Engine.Class" },
        None: { ObjectName: "None", ObjectPath: "" },
        Tag: { TagName: "Meta.Damage.Vehicle" },
        NoTag: { TagName: "None" },
        Label: { Key: "k", LocalizedString: " Humvee\r\n", SourceString: "x", TableId: "t" },
        Vector: { X: 1, Y: 0, Z: -0.4 },
        Gears: [3.6, 2.4],
        Missing: null,
      }),
    ).toEqual({
      Mass: 7250,
      bFlag: true,
      Mode: "EMSuspensionQueryType::Convex",
      Asset: { ref: "/WHL_05/Data/DA_X" },
      Sub: { ref: "/WHL_05/Data/DA_Stats", object: "Eff_C_0" },
      Engine: { ref: "/Script/Engine.Class" },
      None: null,
      Tag: { tag: "Meta.Damage.Vehicle" },
      NoTag: null,
      Label: { text: "Humvee", table: "t", key: "k" },
      Vector: { X: 1, Y: 0, Z: -0.4 },
      Gears: [3.6, 2.4],
      Missing: null,
    });
  });

  it("names the object an export is embedded in", () => {
    expect(normalizeExport({ Type: "Eff", Name: "Eff_0", Outer: { ObjectName: "Stats'DA_Stats'" }, Properties: { A: 1 } })).toEqual({ name: "Eff_0", type: "Eff", outer: "DA_Stats", properties: { A: 1 } });
    expect(normalizeExport({ Type: "Eff", Name: "Eff_0", Properties: {} })).toEqual({ name: "Eff_0", type: "Eff", properties: {} });
  });
});

/** An index over in-memory packages, with the two methods `collectVehicleConfigs` uses. */
function memoryIndex(packages: Record<string, RawExport[]>) {
  const lower = new Map(Object.entries(packages).map(([k, v]) => [k.toLowerCase(), { key: k, exports: v }]));
  const entry = (path: string | undefined | null) => lower.get((path ?? "").replace(/\.[^./]*$/, "").toLowerCase());
  return {
    load: (path: string | undefined | null) => entry(path)?.exports,
    asset: (path: string | undefined | null) => entry(path)?.key.replace(/^\//, "Plugins/"),
    *findAll(type: string | RegExp) {
      for (const [, { key, exports }] of lower) for (const e of exports) if (typeof type === "string" ? e.Type === type : type.test(e.Type)) yield { asset: key, export: e };
    },
  } as unknown as PackageIndex;
}
const pkg = (path: string, type: string, properties: Record<string, unknown>): RawExport[] => [{ Type: type, Name: path.split("/").pop(), Package: path, Properties: properties as never }];

describe("collectVehicleConfigs", () => {
  const packages = {
    "/V/Config": pkg("/V/Config", "MWheeledVehicleConfigDataAsset", { Characteristics: ref("/V/Chars"), Systems: ref("/V/Systems"), GameplayConfigDataAsset: ref("/V/Systems"), Audio: ref("/V/Audio/Engine") }),
    "/V/Chars": pkg("/V/Chars", "Chars", { Mass: 1, Curve: ref("/V/Curve"), Back: ref("/V/Config") }),
    "/V/Systems": pkg("/V/Systems", "Systems", { Curve: ref("/V/Curve"), Class: ref("/Script/Engine") }),
    "/V/Curve": pkg("/V/Curve", "CurveFloat", { FloatCurve: { Keys: [] } }),
    "/V/Other": pkg("/V/Other", "Chars", { Mass: 99 }),
    "/V/ConfigB": pkg("/V/ConfigB", "BHRotaryVehicleConfigDataAsset", { GameplayConfigDataAsset: ref("/V/Systems"), Chars: ref("/V/Chars") }),
  };
  const run = (extra: Record<string, RawExport[]> = {}) =>
    collectVehicleConfigs(memoryIndex({ ...packages, ...extra }), (p) => (p.toLowerCase() === "/v/systems" ? "Vehicle.Land.Wheeled.Test" : undefined), (e) => (e === "Vehicle.Land.Wheeled.Test" ? ["Vehicle.Variant.Land.Wheeled.Test.Default", "Vehicle.Variant.Air.Rotary.Test"] : []));

  it("follows references through every asset once, survives cycles, and sorts", () => {
    const { configs, assets } = run();
    expect(configs.map((c) => c.package)).toEqual(["/V/Config", "/V/ConfigB"]);
    expect(configs[0]!.assets).toEqual(["/V/Chars", "/V/Config", "/V/Curve", "/V/Systems"]);
    expect(assets.map((a) => a.package)).toEqual(["/V/Chars", "/V/Config", "/V/ConfigB", "/V/Curve", "/V/Systems"]); // shared assets once, unreachable /V/Other absent
  });

  it("lists what it could not decode, and ignores engine classes", () => {
    expect(run().unresolved).toEqual(["/V/Audio/Engine"]);
  });

  it("attributes a config to the variants of its own family only", () => {
    const { configs } = run();
    expect(configs[0]).toMatchObject({ family: "wheeled", damageEntity: "Vehicle.Land.Wheeled.Test", variants: ["Vehicle.Variant.Land.Wheeled.Test.Default"] });
    expect(configs[1]).toMatchObject({ family: "rotary", variants: ["Vehicle.Variant.Air.Rotary.Test"] });
  });

  it("lists art and audio packages as skipped, does not publish them and does not follow them", () => {
    const { assets, skipped, configs, unresolved } = run({
      "/V/Mesh": [{ Type: "StaticMesh", Package: "/V/Mesh", Properties: { Materials: ref("/V/Material") } }],
      "/V/Material": pkg("/V/Material", "Chars", {}),
      "/V/Wave": [{ Type: "MetaSoundSource", Package: "/V/Wave" }, { Type: "SweejHDRAssetUserData", Package: "/V/Wave" }],
      "/V/Config": pkg("/V/Config", "MWheeledVehicleConfigDataAsset", { Mesh: ref("/V/Mesh"), Wave: ref("/V/Wave"), Missing: ref("/V/Gone"), Systems: ref("/V/Systems"), GameplayConfigDataAsset: ref("/V/Systems") }),
    });
    expect(skipped).toEqual([{ package: "/V/Mesh", types: ["StaticMesh"] }, { package: "/V/Wave", types: ["MetaSoundSource", "SweejHDRAssetUserData"] }]);
    expect(assets.map((a) => a.package)).not.toContain("/V/Mesh");
    expect(assets.map((a) => a.package)).not.toContain("/V/Material"); // only reachable through the mesh
    expect(configs[0]!.assets).not.toContain("/V/Mesh");
    expect(unresolved).toEqual(["/V/Gone"]);
  });

  it("refuses a config class it does not know instead of skipping it", () => {
    expect(() => run({ "/V/New": pkg("/V/New", "MHoverVehicleConfigDataAsset", {}) })).toThrow(/Unknown vehicle config class MHoverVehicleConfigDataAsset/);
  });
});

describe("packagesPattern", () => {
  const matches = (pkg: string, file: string) => new RegExp(packagesPattern([pkg]), "i").test(file);

  it("matches the file of a game package and of a plugin package, and nothing else", () => {
    expect(matches("/Game/Vehicles/Inputs/IMC_A", "Wardogs/Content/Vehicles/Inputs/IMC_A.uasset")).toBe(true);
    expect(matches("/Game/Vehicles/Inputs/IMC_A", "Wardogs/Content/Vehicles/Inputs/IMC_AB.uasset")).toBe(false);
    expect(matches("/Game/Vehicles/Inputs/IMC_A", "Wardogs/Plugins/GameFeatures/Vehicles/X/Content/Vehicles/Inputs/IMC_A.uasset")).toBe(false);
    expect(matches("/WHL_05/Audio/DA/DA_X", "Wardogs/Plugins/GameFeatures/Vehicles/WHL_05/Content/Audio/DA/DA_X.uasset")).toBe(true);
    expect(matches("/WHL_05/Audio/DA/DA_X", "Wardogs/Plugins/GameFeatures/Vehicles/WHL_06/Content/Audio/DA/DA_X.uasset")).toBe(false);
    expect(matches("/Game/A.B/C", "Wardogs/Content/AxB/C.uasset")).toBe(false); // dots are literal
  });

  it("matches nothing for an empty list", () => {
    expect(new RegExp(packagesPattern([])).test("Wardogs/Content/A.uasset")).toBe(false);
  });
});

const file = VehicleConfigsFile.parse(JSON.parse(readFileSync("data/vehicle-configs.json", "utf8")));
const { vehicles } = VehiclesFile.parse(JSON.parse(readFileSync("data/vehicles.json", "utf8")));
const asset = (pkgPath: string) => file.assets.find((a) => a.package === pkgPath)!;
const props = (pkgPath: string) => asset(pkgPath).exports[0]!.properties as Record<string, any>;

describe("vehicle-configs.json", () => {
  it("is sorted, and every config asset is in the file", () => {
    const sorted = (xs: string[]) => expect(xs).toEqual([...xs].sort());
    sorted(file.configs.map((c) => c.package));
    sorted(file.assets.map((a) => a.package));
    sorted(file.unresolved);
    sorted(file.skipped.map((s) => s.package));
    const have = new Set(file.assets.map((a) => a.package));
    for (const c of file.configs) for (const a of c.assets) expect(have.has(a), `${c.package} -> ${a}`).toBe(true);
  });

  it("holds every vehicle family and every asset belongs to some config", () => {
    expect(new Set(file.configs.map((c) => c.family))).toEqual(new Set(["wheeled", "tracked", "rotary", "airplane", "stationary"]));
    const reached = new Set(file.configs.flatMap((c) => c.assets));
    expect(file.assets.filter((a) => !reached.has(a.package)).map((a) => a.package)).toEqual([]);
  });

  it("resolves every reference to an asset in the file, to a skipped art or audio package, to a package missing from the game files, or to an engine class", () => {
    const known = new Set([...file.assets.map((a) => a.package), ...file.skipped.map((s) => s.package), ...file.unresolved].map((p) => p.toLowerCase()));
    const dangling: string[] = [];
    const walk = (v: unknown, where: string): void => {
      if (Array.isArray(v)) v.forEach((x) => walk(x, where));
      else if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        if (typeof o.ref === "string") {
          if (!o.ref.startsWith("/Script/") && !known.has(o.ref.toLowerCase())) dangling.push(`${where} -> ${o.ref}`);
        } else Object.values(o).forEach((x) => walk(x, where));
      }
    };
    for (const a of file.assets) for (const e of a.exports) walk(e.properties, a.package);
    expect(dangling).toEqual([]);
  });

  it("gives every vehicle in vehicles.json at least one config, and keeps the airplane out of the Little Bird", () => {
    const covered = new Set(file.configs.flatMap((c) => c.variants));
    expect(vehicles.filter((v) => !covered.has(v.id)).map((v) => v.id)).toEqual([]);
    expect(file.configs.find((c) => c.family === "airplane")!.variants).toEqual([]);
  });

  it("agrees with vehicles.json on mass and engine", () => {
    const humvee = file.configs.find((c) => c.package === "/WHL_05/Data/DA_Config_WHL_05_Humvee")!;
    expect(humvee.variants).toEqual(["Vehicle.Variant.Land.Wheeled.Humvee.Default"]);
    const chars = props("/WHL_05/Data/DA_Characteristics_WHL_05_Humvee");
    expect(chars.Mass).toBe(vehicles.find((v) => v.id === humvee.variants[0])!.mass);
    expect(chars).toMatchObject({ Mass: 7250, CenterOfMassOffset: { X: 0, Y: 0, Z: -0.4 }, Abs: 50, ASR: 45, SuspensionQueryType: "EMSuspensionQueryType::Convex" });
  });

  it("canaries across families", () => {
    expect(props("/ROT_02/Data/DA_ROT_02_Body")).toMatchObject({ MassOverride: 7500, CenterOfMassOverride: { X: 0, Y: 0, Z: 200 } });
    expect(props("/TNK_01/Data/Heavy/DA_TNK_01_Heavy_EngineData")).toMatchObject({ DifferentialRatio: 6, EngineExtraPowerRatio: 7.5 });
    expect(props("/TNK_01/Data/DA_TNK_01_DynamicsData").MaxRPM).toBe(5000);
    expect(asset("/Game/Vehicles/Pawns/Air/Helicopter/Data/Curves/CF_GForceControlFalloff_AprilKom").exports[0]!.type).toBe("CurveVector");
    expect(file.assets.some((a) => a.exports.some((e) => e.type === "BHRotaryFlightDataAsset"))).toBe(true);
    // Assets the name patterns alone miss, found by following links: airplane flight curves and input bindings.
    expect(file.assets.some((a) => a.package.endsWith("/Curve_DragCoefFromAngleOfAttackDeg"))).toBe(true);
    expect(file.assets.some((a) => a.exports.some((e) => e.type === "InputMappingContext"))).toBe(true);
    expect(file.skipped.every((s) => s.types.some((t) => /^(MetaSoundSource|StaticMesh|SkeletalMesh|BodySetup|NavCollision|PhysicsAsset|Skeleton|SoundWave|Niagara|Material|Texture)/.test(t)))).toBe(true);
  });
});

/**
 * Every key path with every number, boolean and string in a decoded value. A reference, tag or text is one leaf that
 * names its target, in the same form for the game's shape (`ObjectPath`, `TagName`, `LocalizedString`) and ours.
 */
function signature(v: unknown, path = "", out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x, i) => signature(x, `${path}[${i}]`, out));
  else if (v && typeof v === "object") {
    const o = v as Record<string, any>;
    const keys = Object.keys(o);
    if (typeof o.ObjectPath === "string") out.push(`${path}:ref:${o.ObjectPath === "" || o.ObjectName === "None" ? "" : o.ObjectPath.replace(/\.[^./]*$/, "") + "|" + (/'[^']*:([^':]*)'$/.exec(o.ObjectName)?.[1] ?? "")}`);
    else if (keys.length === 1 && keys[0] === "TagName") out.push(`${path}:tag:${o.TagName === "None" ? "" : o.TagName}`);
    else if ("LocalizedString" in o || "SourceString" in o || "CultureInvariantString" in o) out.push(`${path}:text:${(o.LocalizedString ?? o.SourceString ?? o.CultureInvariantString ?? "").replace(/\r\n?/g, "\n").trim()}|${o.TableId ?? ""}|${o.Key ?? ""}`);
    else if (typeof o.ref === "string") out.push(`${path}:ref:${o.ref}|${o.object ?? ""}`);
    else if (keys.length === 1 && keys[0] === "tag") out.push(`${path}:tag:${o.tag}`);
    else if (typeof o.text === "string") out.push(`${path}:text:${o.text}|${o.table ?? ""}|${o.key ?? ""}`);
    else for (const k of keys) signature(o[k], `${path}.${k}`, out);
  } else if (v === null) out.push(`${path}:null`);
  else out.push(`${path}=${JSON.stringify(v)}`);
  return out;
}

describe.skipIf(!existsSync(".cache/raw/gameplay"))("vehicle-configs.json against the raw cache", () => {
  it("loses no property of any asset: every key path and value is in the file", () => {
    const index = new PackageIndex([".cache/raw/items", ".cache/raw/gameplay"]);
    const lost: string[] = [];
    for (const a of file.assets) {
      const raw = index.load(a.package)!;
      expect(a.exports.length, a.package).toBe(raw.length);
      raw.forEach((exp, i) => {
        const before = signature(exp.Properties ?? {}).sort();
        const after = signature(a.exports[i]!.properties).sort();
        if (JSON.stringify(before) !== JSON.stringify(after)) lost.push(`${a.package} #${i} ${exp.Type}: only before ${before.filter((x) => !after.includes(x)).slice(0, 3)}; only after ${after.filter((x) => !before.includes(x)).slice(0, 3)}`);
      });
    }
    expect(lost).toEqual([]);
  });
});
