import { createHash } from "node:crypto";
import { VehicleModelsFile, type CollisionShape, type ModelPart, type VehicleModel, type VehiclePhysics } from "../schema.gameplay.js";
import type { RawExport } from "./items.js";

type Props = Record<string, any>; // decoded game properties: read by name below

/** A mesh the platform places, before its geometry is read. */
export interface PartSpec {
  /** Object path of the mesh, for example `/ROT_03/Meshes/SM_ROT_03_Body.SM_ROT_03_Body`. */
  mesh: string;
  kind: ModelPart["kind"];
  tag?: string;
  /** Socket or bone the part attaches to; null for the chassis. */
  bone: string | null;
  relative: Transform;
}

/** A translation (centimeters in the game's files, meters after `toMeters`), a rotation quaternion [x, y, z, w] and a scale. */
export interface Transform {
  t: [number, number, number];
  q: [number, number, number, number];
  s: [number, number, number];
}

export const IDENTITY: Transform = { t: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] };

export interface MeshBone {
  name: string;
  parent: number;
  translation: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

/** What the extractor's `export-mesh` writes. Positions are centimeters. */
export interface MeshFile {
  package: string;
  kind: "static" | "skeletal";
  bones: MeshBone[] | null;
  lods: Array<{ triangles: number; positions: number[]; indices: number[] }>;
}

const num = (value: unknown, fallback: number): number => (typeof value === "number" ? value : fallback);
const meshPath = (ref: unknown): string | undefined => {
  const path = (ref as Props | undefined)?.AssetPathName;
  return typeof path === "string" && path !== "" ? path : undefined;
};

/** A game transform (`{ Rotation: {X,Y,Z,W}, Translation: {X,Y,Z}, Scale3D: {X,Y,Z} }`); missing parts are the identity. */
export function readTransform(value: unknown): Transform {
  const v = (value ?? {}) as Props;
  return {
    t: [num(v.Translation?.X, 0), num(v.Translation?.Y, 0), num(v.Translation?.Z, 0)],
    q: [num(v.Rotation?.X, 0), num(v.Rotation?.Y, 0), num(v.Rotation?.Z, 0), num(v.Rotation?.W, 1)],
    s: [num(v.Scale3D?.X, 1), num(v.Scale3D?.Y, 1), num(v.Scale3D?.Z, 1)],
  };
}

const socketOf = (settings: Props | undefined): string | null => {
  const name = settings?.AttachQuery?.SocketName;
  return typeof name === "string" && name !== "" && name.toLowerCase() !== "none" ? name : null;
};

/**
 * The meshes a vehicle platform places, from the exports of its platform package and of the parts its default slots
 * use. A modular vehicle lists them as fragments: one skeletal mesh (the chassis), static meshes attached to one of
 * its bones, and "destructible" meshes (the rotors among them) each with a bone and an offset.
 */
export function collectPartSpecs(packages: readonly RawExport[][]): PartSpec[] {
  const specs: PartSpec[] = [];
  for (const exports of packages) {
    for (const e of exports) {
      const p = (e.Properties ?? {}) as Props;
      if (e.Type === "MVF_SkeletalMesh") {
        const mesh = meshPath(p.SkeletalMesh);
        if (mesh) specs.push({ mesh, kind: "chassis", bone: null, relative: IDENTITY });
      } else if (e.Type === "MVF_StaticMesh") {
        const mesh = meshPath(p.StaticMesh);
        if (mesh) specs.push({ mesh, kind: "static", bone: socketOf(p.ComponentSettings), relative: readTransform(p.RelativeTransform) });
      } else if (e.Type === "MVF_DestructibleMeshes") {
        for (const group of (p.DestructibleMeshesData ?? []) as Props[]) {
          for (const setting of (group.DestructibleMeshesSettings ?? []) as Props[]) {
            const mesh = meshPath(setting.Mesh);
            if (!mesh) continue;
            const tag = setting.MeshTag?.TagName;
            specs.push({ mesh, kind: "destructible", ...(typeof tag === "string" ? { tag } : {}), bone: socketOf(setting.ComponentSettings), relative: readTransform(setting.RelativeTransform) });
          }
        }
      }
    }
  }
  return specs;
}

/** Package path of an object path (`/ROT_03/Meshes/SM_X.SM_X` is `/ROT_03/Meshes/SM_X`). */
export const packageOfObject = (objectPath: string): string => objectPath.replace(/\.[^./]*$/, "");

/** Name of a mesh asset from its object path. */
export const meshName = (objectPath: string): string => packageOfObject(objectPath).split("/").pop()!;

function rotate(q: Transform["q"], v: readonly [number, number, number]): [number, number, number] {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  // v + 2w(q x v) + 2 q x (q x v)
  const cx = y * vz - z * vy;
  const cy = z * vx - x * vz;
  const cz = x * vy - y * vx;
  const dx = y * cz - z * cy;
  const dy = z * cx - x * cz;
  const dz = x * cy - y * cx;
  return [vx + 2 * (w * cx + dx), vy + 2 * (w * cy + dy), vz + 2 * (w * cz + dz)];
}

const multiply = (a: Transform["q"], b: Transform["q"]): Transform["q"] => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

/** `child` placed in the space of `parent`: the transform that does `child` first, then `parent`. */
export function compose(parent: Transform, child: Transform): Transform {
  const scaled: [number, number, number] = [child.t[0] * parent.s[0], child.t[1] * parent.s[1], child.t[2] * parent.s[2]];
  const moved = rotate(parent.q, scaled);
  return {
    t: [parent.t[0] + moved[0], parent.t[1] + moved[1], parent.t[2] + moved[2]],
    q: multiply(parent.q, child.q),
    s: [parent.s[0] * child.s[0], parent.s[1] * child.s[1], parent.s[2] * child.s[2]],
  };
}

/** The pose of a bone in the mesh's space: its own transform combined with each parent's, root first. */
export function boneWorld(bones: readonly MeshBone[], index: number): Transform {
  const chain: number[] = [];
  for (let i = index; i >= 0; i = bones[i]!.parent) chain.unshift(i);
  return chain.reduce<Transform>((world, i) => compose(world, { t: bones[i]!.translation, q: bones[i]!.rotation, s: bones[i]!.scale }), IDENTITY);
}

const round = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded; // no negative zero in the files
};

export function physicsAssetOf(platform: readonly RawExport[]): string | undefined {
  const chassis = platform.find((e) => e.Type === "MVF_SkeletalMesh");
  const path = meshPath((chassis?.Properties as Props | undefined)?.PhysicsAssetOverride);
  return path ? packageOfObject(path) : undefined;
}

export function rotatorToQuat(rotator: unknown): Transform["q"] {
  const r = (rotator ?? {}) as Props;
  const half = Math.PI / 360;
  const [sp, cp] = [Math.sin(num(r.Pitch, 0) * half), Math.cos(num(r.Pitch, 0) * half)];
  const [sy, cy] = [Math.sin(num(r.Yaw, 0) * half), Math.cos(num(r.Yaw, 0) * half)];
  const [sr, cr] = [Math.sin(num(r.Roll, 0) * half), Math.cos(num(r.Roll, 0) * half)];
  return [cr * sp * sy - sr * cp * cy, -cr * sp * cy - sr * cp * sy, cr * cp * sy - sr * sp * cy, cr * cp * cy + sr * sp * sy];
}

const vector = (v: unknown): [number, number, number] => {
  const p = (v ?? {}) as Props;
  return [num(p.X, 0), num(p.Y, 0), num(p.Z, 0)];
};

export function readPhysicsAsset(asset: string, exports: readonly RawExport[], bones: readonly MeshBone[]): VehiclePhysics {
  const setups = exports.filter((e) => e.Type === "SkeletalBodySetup" || e.Type === "BodySetup");
  if (setups.length === 0) throw new Error(`The physics asset ${asset} has no bodies.`);
  const bodies = setups.map((setup) => {
    const p = (setup.Properties ?? {}) as Props;
    const bone = typeof p.BoneName === "string" ? p.BoneName : "";
    const index = bones.findIndex((b) => b.name.toLowerCase() === bone.toLowerCase());
    const bonePose = index >= 0 ? boneWorld(bones, index) : IDENTITY;
    const geometry = (p.AggGeom ?? {}) as Props;
    for (const unsupported of ["ConvexElems", "TaperedCapsuleElems", "LevelSetElems", "SkinnedLevelSetElems", "MLLevelSetElems"]) {
      if (Array.isArray(geometry[unsupported]) && geometry[unsupported].length > 0) throw new Error(`The physics asset ${asset} has ${unsupported}, which the reader does not handle yet.`);
    }
    const place = (element: Props) => compose(bonePose, { t: vector(element.Center), q: rotatorToQuat(element.Rotation), s: [1, 1, 1] });
    const common = (element: Props) => {
      const pose = place(element);
      return {
        name: typeof element.Name === "string" ? element.Name : "",
        center: pose.t.map((v) => round(v / 100, 4)) as [number, number, number],
        rotation: pose.q.map((v) => round(v, 6)) as [number, number, number, number],
        contributesToMass: element.bContributeToMass !== false,
      };
    };
    const shapes: CollisionShape[] = [
      ...((geometry.SphereElems ?? []) as Props[]).map((e): CollisionShape => ({ kind: "sphere", ...common(e), radius: round(num(e.Radius, 0) / 100, 4) })),
      ...((geometry.BoxElems ?? []) as Props[]).map((e): CollisionShape => ({ kind: "box", ...common(e), size: [round(num(e.X, 0) / 100, 4), round(num(e.Y, 0) / 100, 4), round(num(e.Z, 0) / 100, 4)] })),
      ...((geometry.SphylElems ?? []) as Props[]).map((e): CollisionShape => ({ kind: "capsule", ...common(e), radius: round(num(e.Radius, 0) / 100, 4), length: round(num(e.Length, 0) / 100, 4) })),
    ];
    const instance = (p.DefaultInstance ?? {}) as Props;
    return {
      bone,
      ...(instance.bOverrideMaxAngularVelocity === true && typeof instance.MaxAngularVelocity === "number" ? { maxAngularVelocityDegPerS: instance.MaxAngularVelocity } : {}),
      shapes,
    };
  });
  return { asset: asset.replace(/^\//, ""), bodies };
}

/**
 * Builds a vehicle's model: for each placed mesh its geometry (the most detailed level, converted to meters) and its
 * pose in the model's space, which is the pose of the bone it attaches to combined with its own offset.
 */
export function buildVehicleModel(
  id: string,
  platform: string,
  specs: readonly PartSpec[],
  loadMesh: (objectPath: string) => MeshFile | undefined,
  physics?: { asset: string; exports: readonly RawExport[] },
): VehicleModel {
  const chassis = specs.find((s) => s.kind === "chassis");
  const chassisMesh = chassis ? loadMesh(chassis.mesh) : undefined;
  const bones = chassisMesh?.bones ?? [];

  const used = new Set<string>();
  const parts: ModelPart[] = specs.map((spec) => {
    const mesh = loadMesh(spec.mesh);
    if (!mesh) throw new Error(`The mesh ${spec.mesh} of ${id} is not in the cache. Run \`pnpm extract models\` first.`);
    const lod = mesh.lods[0];
    if (!lod) throw new Error(`The mesh ${spec.mesh} has no geometry.`);

    let bonePose = IDENTITY;
    if (spec.bone) {
      const bone = bones.findIndex((b) => b.name.toLowerCase() === spec.bone!.toLowerCase());
      if (bone < 0) throw new Error(`${meshName(spec.mesh)} attaches to bone ${spec.bone}, which the chassis does not have.`);
      bonePose = boneWorld(bones, bone);
    }
    const pose = compose(bonePose, spec.relative);

    let partId = meshName(spec.mesh);
    for (let n = 2; used.has(partId); n++) partId = `${meshName(spec.mesh)}_${n}`;
    used.add(partId);

    return {
      id: partId,
      asset: mesh.package.replace(/^Wardogs\//, "").replace(/\.uasset$/, ""),
      kind: spec.kind,
      ...(spec.tag ? { tag: spec.tag } : {}),
      bone: spec.bone,
      position: pose.t.map((v) => round(v / 100, 3)) as [number, number, number],
      rotation: pose.q.map((v) => round(v, 6)) as [number, number, number, number],
      scale: pose.s.map((v) => round(v, 4)) as [number, number, number],
      vertices: lod.positions.map((v) => round(v / 100, 2)),
      triangles: lod.indices,
    };
  });
  return { id, platform, parts, physics: physics ? readPhysicsAsset(physics.asset, physics.exports, bones) : null };
}

/** A short fingerprint of a part's geometry, for comparing builds without printing a hundred thousand numbers. */
export const geometryHash = (part: Pick<ModelPart, "vertices" | "triangles">): string =>
  createHash("sha256").update(JSON.stringify([part.vertices, part.triangles])).digest("hex").slice(0, 16);

/** The published file for a set of models. */
export const buildVehicleModelsFile = (gameBuild: string, models: readonly VehicleModel[]): VehicleModelsFile =>
  VehicleModelsFile.parse({ schemaVersion: 1, gameBuild, units: "meters", models: [...models].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) });

/**
 * The file as text: indented like the other data files, except that a long list of numbers (vertices, triangles) is written
 * on one line. One number per line would make this file about three times as big.
 */
export const vehicleModelsJson = (file: VehicleModelsFile): string =>
  JSON.stringify(file, (_key, value) => (Array.isArray(value) && value.length > 8 && value.every((n) => typeof n === "number") ? `@@${value.join(",")}@@` : value), 2).replace(/"@@([^"]*)@@"/g, "[$1]") + "\n";
