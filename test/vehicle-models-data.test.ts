import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VehicleModelsFile, VehiclesFile } from "../src/schema.gameplay.js";

const read = (name: string): unknown => JSON.parse(readFileSync(`data/${name}`, "utf8"));
const file = VehicleModelsFile.parse(read("vehicle-models.json"));
const littleBird = file.models.find((m) => m.id === "ROT_03")!;
const part = (id: string) => littleBird.parts.find((p) => p.id === id)!;

/** Size of a part's own bounding box, in meters. */
function size(vertices: readonly number[]): [number, number, number] {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3]!, vertices[i]!);
    hi[i % 3] = Math.max(hi[i % 3]!, vertices[i]!);
  }
  return [hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!];
}

describe("vehicle models", () => {
  it("has the Little Bird, and only the vehicles it has meshes for", () => {
    expect(file.models.map((m) => m.id)).toEqual(["ROT_03"]);
    // The platform folder is part of the asset path of the variants that use the model.
    const { vehicles } = VehiclesFile.parse(read("vehicles.json"));
    expect(vehicles.filter((v) => v.asset.includes("/ROT_03/")).map((v) => v.name)).toContain("MH-6");
  });

  it("has every triangle pointing at a vertex that exists", () => {
    for (const p of littleBird.parts) {
      expect(p.vertices.length % 3, p.id).toBe(0);
      expect(p.triangles.length % 3, p.id).toBe(0);
      expect(p.triangles.reduce((most, n) => Math.max(most, n), 0), p.id).toBeLessThan(p.vertices.length / 3);
    }
  });

  // Checked by hand against the game's meshes and the Little Bird's real size (about 7 m long, rotor about 8.3 m).
  it("is the right size: a body about 7.4 m long, a rotor about 8.3 m across, skids about 2.8 m long", () => {
    const [length, width, height] = size(part("SM_ROT_03_Body").vertices);
    expect(length).toBeGreaterThan(7.2);
    expect(length).toBeLessThan(7.6);
    expect(width).toBeLessThan(2.6);
    expect(height).toBeGreaterThan(2.3);
    expect(Math.max(...size(part("SM_ROT_03_MainRotorBlades").vertices))).toBeGreaterThan(8);
    expect(Math.max(...size(part("SM_ROT_03_MainRotorBlades").vertices))).toBeLessThan(8.6);
    expect(size(part("SM_ROT_03_LeftSkid_01").vertices)[0]).toBeGreaterThan(2.7);
  });

  it("puts the main rotor 2.5 m up and a little behind the middle, and the tail rotor at the end of the tail boom", () => {
    expect(part("SM_ROT_03_MainRotorBlades").position).toEqual([-0.351, 0, 2.481]);
    const tail = part("SM_ROT_03_RearRotor_Blades").position;
    expect(tail[0]).toBeLessThan(-5);
    expect(tail[2]).toBeGreaterThan(1);
  });

  it("tags the rotor parts, which turn about their own z axis", () => {
    expect(littleBird.parts.filter((p) => p.tag?.includes("Rotor.Main")).map((p) => p.id).sort()).toEqual(["SM_ROT_03_MainRotor", "SM_ROT_03_MainRotorBlades", "SM_RotorSpeedmesh"]);
    expect(littleBird.parts.filter((p) => p.tag?.includes("Rotor.Tail")).length).toBe(3);
  });

  it("has the chassis with its cockpit detail, and the exterior shell", () => {
    expect(part("SK_ROT_03").kind).toBe("chassis");
    expect(part("SK_ROT_03").triangles.length / 3).toBe(71365);
    expect(part("SM_ROT_03_Body").triangles.length / 3).toBe(2245);
    expect(littleBird.parts.length).toBe(12);
  });

  it("has the collision shapes the physics engine simulates", () => {
    const [body] = littleBird.physics!.bodies;
    expect(body!.bone).toBe("root_J");
    expect(body!.maxAngularVelocityDegPerS).toBe(720);
    expect(body!.shapes.map((s) => `${s.kind} ${s.name}`)).toEqual(["box Tail", "box Tail", "box Tail", "box Skids", "capsule MainBody"]);
    const cabin = body!.shapes.find((s) => s.kind === "capsule")!;
    expect(cabin).toMatchObject({ center: [-0.35, 0, 1.36], radius: 0.97, length: 2.35 });
    expect(body!.shapes.find((s) => s.name === "Skids")).toMatchObject({ size: [3, 2.5, 0.275] });
  });
});
