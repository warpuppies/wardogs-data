import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GeneratedFile } from "../generated.js";
import { SettingsFile, type UserSetting } from "../schema.gameplay.js";
import type { RawExport } from "./items.js";
import { PackageIndex } from "./packages.js";

type Props = Record<string, any>;

const NUMBER_TYPES = new Set(["BHUserSettingNumericData"]);
const CHOICE_TYPES = new Set(["BHUserSettingDiscreteData", "WDUserSettingToggleConfirmedData", "WDUserSettingDiscretePresetData"]);

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const compact = <T extends object>(obj: T): T => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;

const textOf = (value: unknown): string | undefined => {
  const v = (value ?? {}) as Props;
  for (const text of [v.LocalizedString, v.SourceString]) if (typeof text === "string" && text !== "") return text;
  return undefined;
};

const choiceValue = (key: unknown): string => {
  if (key && typeof key === "object" && typeof (key as Props).TagName === "string") return (key as Props).TagName;
  return String(key ?? "").replace(/^E[A-Za-z0-9_]+::/, "");
};

const nameOfReference = (ref: unknown): string | undefined => {
  const raw = (ref as Props | undefined)?.ObjectName;
  return typeof raw === "string" ? /:([^:']+)'$/.exec(raw)?.[1] : undefined;
};

function readChoices(exports: readonly RawExport[], parameters: Props): Array<{ value: string; label?: string }> {
  const name = nameOfReference(parameters.DefaultValues);
  const values = (exports.find((e) => e.Name === name)?.Properties ?? {}) as Props;
  const list = ((values.NamedValues?.length ? values.NamedValues : values.Values) ?? []) as Props[];
  return list.map((entry) => compact({ value: choiceValue(entry.Key), label: textOf(entry.Value) }));
}

export function readSetting(asset: string, exports: readonly RawExport[]): UserSetting | undefined {
  const main = exports.find((e) => NUMBER_TYPES.has(String(e.Type)) || CHOICE_TYPES.has(String(e.Type)));
  if (!main) return undefined;
  const parameters = ((main.Properties as Props | undefined)?.Parameters ?? {}) as Props;
  const id = String(main.Name);
  const base = { id, asset };
  if (NUMBER_TYPES.has(String(main.Type))) {
    return {
      ...base,
      kind: "number",
      ...compact({
        minimum: num(parameters.Minimum),
        maximum: num(parameters.Maximum),
        default: num(parameters.Default),
        increment: num(parameters.Increment),
        displayMinimum: num(parameters.DisplayMinimum),
        displayMaximum: num(parameters.DisplayMaximum),
        fractionalDigits: num(parameters.FractionalDigits),
        percentage: parameters.bDisplayAsPercentage === true ? (true as const) : undefined,
      }),
    };
  }
  return {
    ...base,
    kind: "choice",
    choices: readChoices(exports, parameters),
    ...compact({ defaultIndex: num(parameters.DefaultIndex), dynamicDefault: parameters.bUsesDynamicDefault === true ? (true as const) : undefined }),
  };
}

export function buildSettingsData(rawDir: string, gameBuild: string): { files: GeneratedFile[]; notes: string[] } {
  const gameplayDir = join(rawDir, "gameplay");
  if (!existsSync(gameplayDir)) throw new Error("The gameplay cache is empty. Run `pnpm extract gameplay` first.");
  const index = new PackageIndex([gameplayDir]);
  const types = new RegExp(`^(${[...NUMBER_TYPES, ...CHOICE_TYPES].join("|")})$`);
  const packages = new Map([...index.findAll(types, "DA_Setting")].map((found) => [found.asset, String(found.export.Package ?? "")]));
  const settings = [...packages]
    .flatMap(([asset, objectPath]) => {
      const setting = readSetting(asset, index.load(objectPath) ?? []);
      return setting ? [setting] : [];
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (settings.length === 0) throw new Error("The gameplay cache has no user settings (`DA_Setting*`). Run `pnpm extract gameplay` first.");
  const file = SettingsFile.parse({ schemaVersion: 1, gameBuild, settings });
  return { files: [{ path: "data/settings.json", content: JSON.stringify(file, null, 2) + "\n" }], notes: [`settings: ${settings.length} user settings`] };
}
