import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MeshFile } from "../src/transform/vehicleModels.js";
import type { RawExport } from "../src/transform/items.js";

const put = (path: string, content: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(content));
};

const mesh = (name: string) => ({ AssetPathName: `/ROT_03/Meshes/${name}.${name}`, SubPathString: "" });
const settings = (socket: string) => ({ AttachQuery: { SourceID: "Chassis", SocketName: socket } });
const quat = (x: number, y: number, z: number, w: number) => ({ X: x, Y: y, Z: z, W: w });

/** The platform of a small vehicle: a chassis, a skid on `body_J`, and a rotor on `mainrotorspin_j` with an offset. */
export const platformExports: RawExport[] = [
  { Type: "ModularVehiclePlatform", Name: "VP_ROT_03", Properties: {} },
  { Type: "ModularVehicleSlot", Name: "Slot_1", Properties: { DefaultPart: { AssetPathName: "/ROT_03/Parts/VP_ROT_03_Body.VP_ROT_03_Body" } } },
  { Type: "ModularVehicleSlot", Name: "Slot_2", Properties: { Type: "EModularVehicleSlotType::Optional" } },
  { Type: "MVF_SkeletalMesh", Name: "MVF_SkeletalMesh_0", Properties: { SkeletalMesh: mesh("SK_ROT_03"), PhysicsAssetOverride: mesh("PA_ROT_03"), ComponentSettings: { Tags: ["Chassis"] } } },
  { Type: "MVF_StaticMesh", Name: "MVF_StaticMesh_0", Properties: { StaticMesh: mesh("SM_Skid"), ComponentSettings: settings("body_J") } },
  {
    Type: "MVF_DestructibleMeshes",
    Name: "MVF_DestructibleMeshes_0",
    Properties: {
      DestructibleMeshesData: [
        {
          DestructibleMeshGroupTag: { TagName: "Vehicle.DestructibleMesh.Rotor.Main" },
          DestructibleMeshesSettings: [
            {
              Mesh: mesh("SM_Blades"),
              MeshTag: { TagName: "Vehicle.DestructibleMesh.Rotor.Main.Blades" },
              ComponentSettings: settings("mainrotorspin_j"),
              RelativeTransform: { Rotation: quat(0, 0, 0, 1), Translation: { X: 0, Y: 0, Z: 10 }, Scale3D: { X: 1, Y: 1, Z: 1 } },
            },
          ],
        },
      ],
    },
  },
];

export const physicsExports: RawExport[] = [
  { Type: "PhysicsAsset", Name: "PA_ROT_03", Properties: { SkeletalBodySetups: [{ ObjectName: "SkeletalBodySetup'PA_ROT_03:SkeletalBodySetup_0'" }] } },
  {
    Type: "SkeletalBodySetup",
    Name: "SkeletalBodySetup_0",
    Properties: {
      BoneName: "body_J",
      AggGeom: {
        BoxElems: [{ Center: { X: 10, Y: 0, Z: 0 }, Rotation: { Pitch: 0, Yaw: 0, Roll: 0 }, X: 200, Y: 100, Z: 50, Name: "Skids", bContributeToMass: true }],
        SphylElems: [{ Center: { X: 0, Y: 0, Z: 100 }, Rotation: { Pitch: -90, Yaw: 0, Roll: 0 }, Radius: 90, Length: 200, Name: "MainBody" }],
      },
      DefaultInstance: { bOverrideMaxAngularVelocity: true, MaxAngularVelocity: 720 },
    },
  },
];

/** The body part the platform's default slot uses: a mesh on `body_J`. */
export const bodyPartExports: RawExport[] = [
  { Type: "ModularVehiclePart", Name: "VP_ROT_03_Body", Properties: {} },
  { Type: "MVF_StaticMesh", Name: "MVF_StaticMesh_5", Properties: { StaticMesh: mesh("SM_Body"), ComponentSettings: settings("body_J") } },
];

/** One triangle with its corner at the origin, `size` centimeters on each side. */
export const triangle = (name: string, size = 100, kind: MeshFile["kind"] = "static", bones: MeshFile["bones"] = null): MeshFile => ({
  package: `Wardogs/Plugins/GameFeatures/Vehicles/ROT_03/Content/Meshes/${name}.uasset`,
  kind,
  bones,
  lods: [{ triangles: 1, positions: [0, 0, 0, size, 0, 0, 0, size, 0], indices: [0, 1, 2] }],
});

/** Bones: a root, `body_J` 57 cm up, and a rotor bone 191 cm above that and 35 cm back, tilted 90 degrees about z. */
export const bones = [
  { name: "root_J", parent: -1, translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
  { name: "body_J", parent: 0, translation: [0, 0, 57], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
  { name: "mainRotorSpin_J", parent: 1, translation: [-35, 0, 191], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2], scale: [1, 1, 1] },
] as NonNullable<MeshFile["bones"]>;

export const meshes: Record<string, MeshFile> = {
  SK_ROT_03: triangle("SK_ROT_03", 100, "skeletal", bones),
  SM_Skid: triangle("SM_Skid", 50),
  SM_Blades: triangle("SM_Blades", 200),
  SM_Body: triangle("SM_Body", 300),
};

/** Writes the cache the `models` dataset reads: the decoded platform and part packages, and the mesh files. */
export function writeModelsFixture(raw: string): void {
  const content = join(raw, "models", "json", "Wardogs", "Plugins", "GameFeatures", "Vehicles", "ROT_03", "Content");
  put(join(content, "Platform", "VP_ROT_03.json"), platformExports);
  put(join(content, "Parts", "VP_ROT_03_Body.json"), bodyPartExports);
  put(join(content, "Meshes", "PA_ROT_03.json"), physicsExports);
  for (const [name, file] of Object.entries(meshes)) put(join(raw, "models", "meshes", "ROT_03", `${name}.json`), file);
}
