import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { exportBuildingParts, exportJson, exportRvtVolumes, exportTexture, EXCLUDE_NOTHING } from "../extract/run.js";
import { buildBuildings, buildBuildingsFile, buildingsToGeoJson, parsePartRows } from "../maps/buildings.js";
import { buildMap, parseMapName, parseMinimapData } from "../maps/mapMeta.js";
import { assertBuildingsOnTerrain, buildTerrain, checkBuildingsOnTerrain, findHeightVolume, loadHeightmap, parseRvtVolumes } from "../maps/terrain.js";
import { readPngSize } from "../maps/tiles.js";
import { SERVER_BROWSER_TABLE, WORLDS, worldLevelPackage, worldMapDataPath, worldTexturePackage } from "../maps/worlds.js";
import type { RawExport } from "../transform/items.js";
import type { GeneratedFile } from "../generated.js";
import type { Dataset } from "./types.js";

const INCLUDE = String.raw`/(WorldCapture/Textures/[^/]+/DA_UI_[^/]+|FindMatch/Data/DT_ServerBrowserMapTexture)\.uasset$`;

const readJson = (path: string): RawExport[] => JSON.parse(readFileSync(path, "utf8")) as RawExport[];

export const mapsDataset: Dataset = {
  id: "maps",
  async extract(config) {
    const dir = join(config.rawDir, "maps");
    // Everything below is independent, so it all runs at once. The big map images take longest, so they are asked for first.
    await Promise.all([
      ...WORLDS.map((w) => exportTexture(config, worldTexturePackage(w), join(dir, `${w.id}.png`))),
      exportJson(config, INCLUDE, EXCLUDE_NOTHING, join(dir, "json")),
      ...WORLDS.flatMap((w) => [
        exportBuildingParts(config, `Wardogs/Content/Maps/Worlds/${w.folder}/`, join(dir, `${w.id}.parts.jsonl`)),
        exportTexture(config, w.heightTexture, join(dir, `${w.id}.height.png`)),
        exportRvtVolumes(config, worldLevelPackage(w), join(dir, `${w.id}.rvt.json`)),
      ]),
    ]);
  },
  async build(rawDir, meta) {
    const dir = join(rawDir, "maps");
    const serverTable = readJson(join(dir, "json", `${SERVER_BROWSER_TABLE}.json`));

    // The worlds are independent, and decoding a heightmap waits on the image decoder, so they are built together.
    const built = await Promise.all(
      WORLDS.map(async (w) => {
        const files: GeneratedFile[] = [];
        const notes: string[] = [];
        const minimap = parseMinimapData(readJson(join(dir, "json", `${worldMapDataPath(w)}.json`)));
        const png = join(dir, `${w.id}.png`);
        const map = buildMap(w, minimap, parseMapName(serverTable, w.serverRow), meta.gameBuild, readPngSize(png));
        files.push({ path: `data/maps/${w.id}/map.json`, content: JSON.stringify(map, null, 2) + "\n" });

        const partsFile = join(dir, `${w.id}.parts.jsonl`);
        const { buildings, partsWithoutExtent } = buildBuildings(existsSync(partsFile) ? parsePartRows(readFileSync(partsFile, "utf8")) : []);

        const heightPng = join(dir, `${w.id}.height.png`);
        const hm = await loadHeightmap(heightPng);
        const volume = findHeightVolume(parseRvtVolumes(readFileSync(join(dir, `${w.id}.rvt.json`), "utf8")), w.heightTexture);
        const draft = buildTerrain(w, volume, hm, meta.gameBuild, { buildings: 0, medianOffset: 0, p5Offset: 0, p95Offset: 0, fractionWithin5m: 0 });
        const check = checkBuildingsOnTerrain(draft, hm, buildings);
        assertBuildingsOnTerrain(w.id, check);
        const terrain = buildTerrain(w, volume, hm, meta.gameBuild, check);
        files.push({ path: `data/maps/${w.id}/terrain.json`, content: JSON.stringify(terrain, null, 2) + "\n" });
        files.push({ path: `data/maps/${w.id}/buildings.json`, content: JSON.stringify(buildBuildingsFile(w.folder, meta.gameBuild, buildings), null, 2) + "\n" });
        files.push({ path: `data/maps/${w.id}/buildings.geojson`, content: JSON.stringify(buildingsToGeoJson(w.folder, meta.gameBuild, buildings), null, 2) + "\n" });

        notes.push(
          `${w.id} (${map.name}): image ${map.image.width}px at ${map.image.metersPerPixel.toFixed(3)} m/px, ${buildings.length} buildings, terrain ${terrain.heightmap.width}px (${terrain.heightmap.metersPerPixel[0]} m/px), buildings sit ${check.medianOffset} m from terrain` +
            (partsWithoutExtent ? `, ${partsWithoutExtent} parts skipped (no size)` : ""),
        );
        if (buildings.length === 0) notes.push(`warning: no destructible buildings found for ${w.id}`);
        return { files, notes };
      }),
    );
    const files = built.flatMap((b) => b.files);
    const notes = built.flatMap((b) => b.notes);
    return { files, notes };
  },
};
