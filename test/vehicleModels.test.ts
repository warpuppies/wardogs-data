import { describe, expect, it } from "vitest";
import { VehicleModelsFile } from "../src/schema.gameplay.js";
import { boneWorld, buildVehicleModel, buildVehicleModelsFile, collectPartSpecs, compose, geometryHash, IDENTITY, meshName, physicsAssetOf, readPhysicsAsset, readTransform, rotatorToQuat, vehicleModelsJson, type MeshFile, type Transform } from "../src/transform/vehicleModels.js";
import { bodyPartExports, bones, meshes, physicsExports, platformExports, triangle } from "./modelsFixture.js";

const loadMesh = (objectPath: string): MeshFile | undefined => meshes[meshName(objectPath)];
const close = (actual: readonly number[], expected: readonly number[], digits = 6) => actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, digits));

describe("readTransform", () => {
  it("reads a game transform and fills in what is missing with the identity", () => {
    expect(readTransform({ Rotation: { X: 0, Y: 0, Z: 1, W: 0 }, Translation: { X: 1, Y: 2, Z: 3 }, Scale3D: { X: 2, Y: 2, Z: 2 } })).toEqual({ t: [1, 2, 3], q: [0, 0, 1, 0], s: [2, 2, 2] });
    expect(readTransform(undefined)).toEqual(IDENTITY);
    expect(readTransform({ Translation: { X: 5 } }).t).toEqual([5, 0, 0]);
  });
});

describe("compose and boneWorld", () => {
  it("places a child in its parent's space: rotate by the parent, then move", () => {
    const parent: Transform = { t: [10, 0, 0], q: [0, 0, Math.SQRT1_2, Math.SQRT1_2], s: [1, 1, 1] }; // turned 90 degrees about z
    const world = compose(parent, { t: [1, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] });
    close(world.t, [10, 1, 0]); // the child's +x became +y
    close(world.q, [0, 0, Math.SQRT1_2, Math.SQRT1_2]);
  });

  it("scales the child's offset by the parent's scale", () => {
    const world = compose({ t: [0, 0, 0], q: [0, 0, 0, 1], s: [2, 2, 2] }, { t: [1, 1, 1], q: [0, 0, 0, 1], s: [1, 1, 1] });
    expect(world.t).toEqual([2, 2, 2]);
    expect(world.s).toEqual([2, 2, 2]);
  });

  it("walks a bone chain from the root", () => {
    close(boneWorld(bones, 1).t, [0, 0, 57]);
    close(boneWorld(bones, 2).t, [-35, 0, 248]); // 57 + 191 up, 35 back
    close(boneWorld(bones, 2).q, [0, 0, Math.SQRT1_2, Math.SQRT1_2]);
  });
});

describe("collectPartSpecs", () => {
  const specs = collectPartSpecs([platformExports, bodyPartExports]);

  it("finds the chassis, the static meshes and the destructible meshes, with their bones", () => {
    expect(specs.map((s) => [meshName(s.mesh), s.kind, s.bone])).toEqual([
      ["SK_ROT_03", "chassis", null],
      ["SM_Skid", "static", "body_J"],
      ["SM_Blades", "destructible", "mainrotorspin_j"],
      ["SM_Body", "static", "body_J"],
    ]);
  });

  it("keeps the tag and the offset of a destructible mesh", () => {
    const blades = specs.find((s) => s.kind === "destructible")!;
    expect(blades.tag).toBe("Vehicle.DestructibleMesh.Rotor.Main.Blades");
    expect(blades.relative.t).toEqual([0, 0, 10]);
  });

  it("ignores fragments that name no mesh", () => {
    expect(collectPartSpecs([[{ Type: "MVF_StaticMesh", Properties: { StaticMesh: { AssetPathName: "" } } }, { Type: "MVF_Seats", Properties: {} }]])).toEqual([]);
  });
});

describe("buildVehicleModel", () => {
  const specs = collectPartSpecs([platformExports, bodyPartExports]);
  const model = buildVehicleModel("ROT_03", "/ROT_03/Platform/VP_ROT_03", specs, loadMesh);
  const part = (id: string) => model.parts.find((p) => p.id === id)!;

  it("lists the parts in the order the game places them, chassis included", () => {
    expect(model.parts.map((p) => p.id)).toEqual(["SK_ROT_03", "SM_Skid", "SM_Blades", "SM_Body"]);
    expect(model.parts[0]!.kind).toBe("chassis");
  });

  it("converts geometry to meters and keeps triangles", () => {
    expect(part("SM_Body").vertices).toEqual([0, 0, 0, 3, 0, 0, 0, 3, 0]);
    expect(part("SM_Body").triangles).toEqual([0, 1, 2]);
    expect(part("SM_Body").asset).toBe("Plugins/GameFeatures/Vehicles/ROT_03/Content/Meshes/SM_Body");
  });

  it("puts a part where its bone is, in meters, finding the bone whatever its capitals", () => {
    expect(part("SM_Skid").position).toEqual([0, 0, 0.57]);
    // The rotor bone is at 2.48 m up and 0.35 m back, and the part's own offset adds 10 cm along the bone's up axis.
    expect(part("SM_Blades").position).toEqual([-0.35, 0, 2.58]);
    close(part("SM_Blades").rotation, [0, 0, Math.SQRT1_2, Math.SQRT1_2], 5);
  });

  it("leaves the chassis at the origin", () => {
    expect(part("SK_ROT_03").position).toEqual([0, 0, 0]);
    expect(part("SK_ROT_03").bone).toBeNull();
  });

  it("fails clearly when a bone or a mesh is missing", () => {
    const orphan = [specs[0]!, { ...specs[1]!, bone: "no_such_bone" }];
    expect(() => buildVehicleModel("X", "/X", orphan, loadMesh)).toThrow(/attaches to bone no_such_bone/);
    expect(() => buildVehicleModel("X", "/X", specs, (m) => (meshName(m) === "SM_Body" ? undefined : loadMesh(m)))).toThrow(/SM_Body of X is not in the cache/);
  });

  it("gives two placements of the same mesh different ids", () => {
    const twice = [specs[0]!, specs[1]!, specs[1]!];
    expect(buildVehicleModel("X", "/X", twice, loadMesh).parts.map((p) => p.id)).toEqual(["SK_ROT_03", "SM_Skid", "SM_Skid_2"]);
  });

  it("rounds to the centimeter and never writes a negative zero", () => {
    const rough: MeshFile = { ...triangle("SM_Body"), lods: [{ triangles: 1, positions: [-0.2, 0.004, 100.456, 1, 2, 3, 4, 5, 6], indices: [0, 1, 2] }] };
    const built = buildVehicleModel("X", "/X", [specs[0]!, specs[3]!], (m) => (meshName(m) === "SM_Body" ? rough : loadMesh(m)));
    expect(Object.is(built.parts[1]!.vertices[0], 0)).toBe(true);
    expect(built.parts[1]!.vertices.slice(0, 3)).toEqual([0, 0, 1]);
  });
});

describe("rotatorToQuat", () => {
  it("turns the engine's degrees into the quaternion the engine would use", () => {
    close(rotatorToQuat({ Pitch: 0, Yaw: 0, Roll: 0 }), [0, 0, 0, 1]);
    close(rotatorToQuat({ Yaw: 90 }), [0, 0, Math.SQRT1_2, Math.SQRT1_2]);
    close(rotatorToQuat({ Pitch: -90 }), [0, Math.SQRT1_2, 0, Math.SQRT1_2]);
  });

  it("points a pitched capsule's own z axis forward", () => {
    const along = compose({ t: [0, 0, 0], q: rotatorToQuat({ Pitch: -90 }), s: [1, 1, 1] }, { t: [0, 0, 1], q: [0, 0, 0, 1], s: [1, 1, 1] }).t;
    close(along, [1, 0, 0]);
  });
});

describe("physics asset", () => {
  it("is the one the platform gives its chassis", () => {
    expect(physicsAssetOf(platformExports)).toBe("/ROT_03/Meshes/PA_ROT_03");
    expect(physicsAssetOf([{ Type: "MVF_SkeletalMesh", Properties: {} }])).toBeUndefined();
  });

  const physics = readPhysicsAsset("/ROT_03/Meshes/PA_ROT_03", physicsExports, bones);
  const [box, capsule] = physics.bodies[0]!.shapes;

  it("reads every body with its bone and the engine's turning limit", () => {
    expect(physics.asset).toBe("ROT_03/Meshes/PA_ROT_03");
    expect(physics.bodies.map((b) => [b.bone, b.maxAngularVelocityDegPerS])).toEqual([["body_J", 720]]);
  });

  it("converts shapes to meters and full sizes, placed with their bone (body_J is 57 cm up)", () => {
    expect(box).toEqual({ kind: "box", name: "Skids", center: [0.1, 0, 0.57], rotation: [0, 0, 0, 1], contributesToMass: true, size: [2, 1, 0.5] });
    expect(capsule).toMatchObject({ kind: "capsule", name: "MainBody", center: [0, 0, 1.57], radius: 0.9, length: 2, contributesToMass: true });
    if (capsule?.kind === "capsule") close(capsule.rotation, [0, Math.SQRT1_2, 0, Math.SQRT1_2]);
  });

  it("fails on a kind of shape it cannot read, so a new vehicle is noticed", () => {
    const convex = [{ Type: "SkeletalBodySetup", Properties: { BoneName: "root_J", AggGeom: { ConvexElems: [{}] } } }];
    expect(() => readPhysicsAsset("/X/PA", convex, bones)).toThrow(/ConvexElems/);
    expect(() => readPhysicsAsset("/X/PA", [], bones)).toThrow(/no bodies/);
  });

  it("is in the model when the platform names one, and null otherwise", () => {
    const specs = collectPartSpecs([platformExports, bodyPartExports]);
    expect(buildVehicleModel("X", "/X", specs, loadMesh, { asset: "/ROT_03/Meshes/PA_ROT_03", exports: physicsExports }).physics?.bodies[0]?.shapes.length).toBe(2);
    expect(buildVehicleModel("X", "/X", specs, loadMesh).physics).toBeNull();
  });
});

describe("the published file", () => {
  const model = buildVehicleModel("ROT_03", "/ROT_03/Platform/VP_ROT_03", collectPartSpecs([platformExports, bodyPartExports]), loadMesh);

  it("matches its schema", () => {
    expect(() => VehicleModelsFile.parse(buildVehicleModelsFile("100", [model]))).not.toThrow();
  });

  it("writes long number lists on one line and reads back the same", () => {
    const file = buildVehicleModelsFile("100", [{ ...model, parts: [{ ...model.parts[0]!, vertices: Array.from({ length: 30 }, (_, i) => i / 10) }] }]);
    const text = vehicleModelsJson(file);
    expect(text).toContain(`"vertices": [0,0.1,0.2`);
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(file);
  });

  it("fingerprints geometry, so a report can say a part changed without printing it", () => {
    const a = geometryHash({ vertices: [0, 1, 2], triangles: [0, 1, 2] });
    expect(a).toBe(geometryHash({ vertices: [0, 1, 2], triangles: [0, 1, 2] }));
    expect(a).not.toBe(geometryHash({ vertices: [0, 1, 3], triangles: [0, 1, 2] }));
  });
});
