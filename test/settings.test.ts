import { describe, expect, it } from "vitest";
import { SettingsFile } from "../src/schema.gameplay.js";
import { readSetting } from "../src/transform/settings.js";
import { settingsExports } from "./gameplayFixture.js";

describe("readSetting", () => {
  it("reads a number setting's range and starting value", () => {
    expect(readSetting("Plugins/BHFramework/Content/Settings/General/DA_Setting_General_FieldOfView_Vehicle", settingsExports.fieldOfView)).toEqual({
      id: "DA_Setting_General_FieldOfView_Vehicle",
      asset: "Plugins/BHFramework/Content/Settings/General/DA_Setting_General_FieldOfView_Vehicle",
      kind: "number",
      minimum: 60,
      maximum: 110,
      default: 85,
      increment: 1,
      fractionalDigits: 0,
    });
  });

  it("reads a choice's values in order and which one is the default", () => {
    const setting = readSetting("A", settingsExports.rotaryMouse);
    expect(setting).toEqual({ id: "DA_Setting_Controls_ActionBehaviour_RotaryMouse", asset: "A", kind: "choice", choices: [{ value: "True" }, { value: "False" }], defaultIndex: 1 });
  });

  it("names enum choices without their type, keeps their English text, and reads gameplay tags", () => {
    const exports = [
      { Type: "BHUserSettingDiscreteData", Name: "DA_Axis", Properties: { Parameters: { DefaultValues: { ObjectName: "BHUserSettingEnumDiscreteValues'DA_Axis:Values_0'" } } } },
      { Type: "BHUserSettingEnumDiscreteValues", Name: "Values_0", Properties: { NamedValues: [{ Key: "EWDRotaryMouseXFunction::Roll", Value: { SourceString: "Roll", LocalizedString: "Roll" } }], Values: [{ Key: "0" }] } },
    ];
    expect(readSetting("A", exports)).toMatchObject({ choices: [{ value: "Roll", label: "Roll" }] });
    const tags = [
      { Type: "BHUserSettingDiscreteData", Name: "DA_Tags", Properties: { Parameters: { DefaultValues: { ObjectName: "X'DA_Tags:Tags_0'" } } } },
      { Type: "BHUserSettingGameplayTagDiscreteValues", Name: "Tags_0", Properties: { Values: [{ Key: { TagName: "Input.Config.Default" }, Value: { LocalizedString: "Default" } }] } },
    ];
    expect(readSetting("A", tags)).toMatchObject({ choices: [{ value: "Input.Config.Default", label: "Default" }] });
  });

  it("leaves out what the asset does not store, and skips assets that are not settings", () => {
    const sparse = readSetting("A", [{ Type: "BHUserSettingNumericData", Name: "DA_Isolation", Properties: { Parameters: { Maximum: 100, bDisplayAsPercentage: true } } }]);
    expect(sparse).toEqual({ id: "DA_Isolation", asset: "A", kind: "number", maximum: 100, percentage: true });
    expect(readSetting("A", [{ Type: "WDUISettingsPanelData", Name: "DA_Panel", Properties: {} }])).toBeUndefined();
  });

  it("matches the schema", () => {
    const settings = [readSetting("A", settingsExports.fieldOfView)!, readSetting("B", settingsExports.rotaryMouse)!];
    expect(() => SettingsFile.parse({ schemaVersion: 1, gameBuild: "1", settings })).not.toThrow();
  });
});
