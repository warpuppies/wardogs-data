/** A game world with a tactical map. Declared here, not inferred, so adding a world is a reviewable change. */
export interface WorldDef {
  /** Output id (folder name under data/maps). */
  id: string;
  /** Folder name used by the game for the world's level and map capture. */
  folder: string;
  /** Row key in the server-browser table that names the map shown for this world. */
  serverRow: string;
  /** Package path of the baked terrain height texture (a 16-bit virtual texture). */
  heightTexture: string;
}

export const WORLDS: readonly WorldDef[] = [
  { id: "kavkazi", folder: "Kavkazi", serverRow: "Bakurani_KOTH_01", heightTexture: "Wardogs/Content/Maps/Worlds/Kavkazi/LandscapeMaterial/RVT_Kavkazi_Height_SVT.uasset" },
  { id: "europe", folder: "Europe", serverRow: "Madrid_KOTH_01", heightTexture: "Wardogs/Content/Maps/Worlds/Europe/Landscape/SVT_Spain_Height.uasset" },
  { id: "north-america", folder: "NorthAmerica", serverRow: "Detroit_KOTH_01", heightTexture: "Wardogs/Content/Maps/Worlds/NorthAmerica/Landscape/SVT_NorthAmerica_Height.uasset" },
];

export const worldMapDataPath = (w: WorldDef) =>
  `Wardogs/Content/UI/Tools/WorldCapture/Textures/${w.folder}/DA_UI_${w.folder}`;
export const worldTexturePackage = (w: WorldDef) =>
  `Wardogs/Content/UI/Tools/WorldCapture/Textures/${w.folder}/T_UI_${w.folder}_VT.uasset`;
export const SERVER_BROWSER_TABLE = "Wardogs/Content/UI/Features/Frontend/FindMatch/Data/DT_ServerBrowserMapTexture";
export const worldLevelPackage = (w: WorldDef) => `Wardogs/Content/Maps/Worlds/${w.folder}/${w.folder}.umap`;
