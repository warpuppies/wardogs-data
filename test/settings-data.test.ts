import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SettingsFile } from "../src/schema.gameplay.js";

const { settings } = SettingsFile.parse(JSON.parse(readFileSync("data/settings.json", "utf8")));
const setting = (id: string) => settings.find((s) => s.id === id)!;

describe("settings", () => {
  it("has the vehicle field of view: 60 to 110 degrees, 85 to start", () => {
    expect(setting("DA_Setting_General_FieldOfView_Vehicle")).toMatchObject({ kind: "number", minimum: 60, maximum: 110, default: 85 });
    expect(setting("DA_Setting_General_FieldOfView")).toMatchObject({ minimum: 60, maximum: 120, default: 90 });
  });

  it("starts with helicopter mouse control off", () => {
    const mouse = setting("DA_Setting_Controls_ActionBehaviour_RotaryMouse");
    expect(mouse.kind).toBe("choice");
    if (mouse.kind === "choice") expect(mouse.choices[mouse.defaultIndex ?? 0]?.value).toBe("False");
  });

  it("has the helicopter mouse axes and sensitivities", () => {
    const x = setting("DA_Setting_Controls_RotaryMouseAxisX");
    if (x.kind === "choice") expect(x.choices.map((c) => c.value)).toEqual(["Roll", "Yaw", "Disabled"]);
    for (const axis of ["Pitch", "Roll", "Yaw"]) expect(setting(`DA_Setting_Controls_RotaryMouse${axis}Sensitivity`)).toMatchObject({ minimum: 1, maximum: 100, default: 50, percentage: true });
  });

  it("is sorted by id, with no duplicates", () => {
    const ids = settings.map((s) => s.id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });
});
