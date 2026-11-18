import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { packagesPattern } from "../extract/linked.js";
import { EXCLUDE_NOTHING, exportJson, exportMesh } from "../extract/run.js";
import { PackageIndex } from "../transform/packages.js";
import type { RawExport } from "../transform/items.js";
import { buildVehicleModel, buildVehicleModelsFile, collectPartSpecs, meshName, physicsAssetOf, vehicleModelsJson, type MeshFile, type PartSpec } from "../transform/vehicleModels.js";
import type { Dataset } from "./types.js";

/** The vehicle platforms whose models are extracted. A platform asset lists the parts its default slots use. */
export const MODEL_PLATFORMS = [{ id: "ROT_03", platform: "/ROT_03/Platform/VP_ROT_03" }] as const;

const jsonDir = (rawDir: string) => join(rawDir, "models", "json");
const meshFile = (rawDir: string, id: string, objectPath: string) => join(rawDir, "models", "meshes", id, `${meshName(objectPath)}.json`);

/** The packages of the parts that the platform's slots use by default (body, seats, config). */
const defaultParts = (platform: RawExport[]): string[] =>
  platform
    .filter((e) => e.Type === "ModularVehicleSlot")
    .map((e) => ((e.Properties?.DefaultPart as { AssetPathName?: string } | undefined)?.AssetPathName ?? "").replace(/\.[^./]*$/, ""))
    .filter((p) => p !== "");

/** The exports of the platform package and of its default parts, read from the cache. */
function loadPackages(index: PackageIndex, platform: string): { platform: RawExport[]; all: RawExport[][] } {
  const exports = index.load(platform);
  if (!exports) throw new Error(`The platform ${platform} is not in the cache. Run \`pnpm extract models\` first.`);
  return { platform: exports, all: [exports, ...defaultParts(exports).map((p) => index.load(p) ?? [])] };
}

/**
 * The 3D shape of vehicles: the meshes of a vehicle platform, with the bone each attaches to and its offset. The
 * extraction decodes the platform and its default parts, then every mesh they place.
 */
export const vehicleModelsDataset: Dataset = {
  id: "models",
  async extract(config) {
    const dir = jsonDir(config.rawDir);
    rmSync(join(config.rawDir, "models"), { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const { id, platform } of MODEL_PLATFORMS) {
      await exportJson(config, packagesPattern([platform]), EXCLUDE_NOTHING, dir, true);
      const platformExports = new PackageIndex([dir]).load(platform);
      if (!platformExports) throw new Error(`The platform ${platform} of ${id} is not in the game files.`);
      const physicsAsset = physicsAssetOf(platformExports);
      await exportJson(config, packagesPattern([...defaultParts(platformExports), ...(physicsAsset ? [physicsAsset] : [])]), EXCLUDE_NOTHING, dir, true);

      const specs = collectPartSpecs(loadPackages(new PackageIndex([dir]), platform).all);
      await Promise.all([...new Set(specs.map((s) => s.mesh))].map((mesh) => exportMesh(config, mesh, meshFile(config.rawDir, id, mesh))));
    }
  },
  async build(rawDir, meta) {
    const dir = jsonDir(rawDir);
    if (!existsSync(dir)) throw new Error("The vehicle models are not in the cache. Run `pnpm extract models` first.");
    const index = new PackageIndex([dir]);
    const notes: string[] = [];
    const models = MODEL_PLATFORMS.map(({ id, platform }) => {
      const packages = loadPackages(index, platform);
      const specs: PartSpec[] = collectPartSpecs(packages.all);
      const physicsAsset = physicsAssetOf(packages.platform);
      const physicsExports = physicsAsset ? index.load(physicsAsset) : undefined;
      if (physicsAsset && !physicsExports) throw new Error(`The physics asset ${physicsAsset} of ${id} is not in the cache. Run \`pnpm extract models\` first.`);
      const model = buildVehicleModel(
        id,
        platform,
        specs,
        (mesh) => {
          const file = meshFile(rawDir, id, mesh);
          return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as MeshFile) : undefined;
        },
        physicsAsset && physicsExports ? { asset: physicsAsset, exports: physicsExports } : undefined,
      );
      notes.push(`model ${id}: ${model.parts.length} parts, ${model.parts.reduce((n, p) => n + p.triangles.length / 3, 0)} triangles, ${model.physics?.bodies.reduce((n, b) => n + b.shapes.length, 0) ?? 0} collision shapes`);
      return model;
    });
    return { files: [{ path: "data/vehicle-models.json", content: vehicleModelsJson(buildVehicleModelsFile(meta.gameBuild, models)) }], notes };
  },
};
