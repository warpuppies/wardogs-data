import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { RewardsFile, RolesFile, SkillsFile } from "../src/schema.gameplay.js";
import { ItemsFile } from "../src/schema.js";
import type { RawExport } from "../src/transform/items.js";
import { buildProgressionData, nodeOnlySkills, parseRewards, parseRoles, parseSkillLayout, parseSkillNodes, parseSkills } from "../src/transform/progression.js";

const table = (struct: string, rows: Record<string, unknown>): RawExport[] => [
  { Type: "DataTable", Properties: { RowStruct: { ObjectName: `Class'${struct}'` } } as never, Rows: rows as never },
];
const invariant = (v: string) => ({ CultureInvariantString: v });

describe("parseSkillNodes", () => {
  it("reads the display name and description by skill tag", () => {
    const nodes = parseSkillNodes(table("WDMetaTreeNodeData_UI", { "Meta.Role.Infantry.StrongArm": { FriendlyName: invariant("Strong arm"), Description: invariant("Throw further.") }, "Meta.Role.Infantry.Empty": {} }));
    expect(nodes.get("Meta.Role.Infantry.StrongArm")).toEqual({ name: "Strong arm", description: "Throw further." });
    expect(nodes.get("Meta.Role.Infantry.Empty")).toEqual({});
  });
});

describe("parseSkillLayout", () => {
  const preset = (tag: string, row: number, column: number) => ({ EntryID: { TagName: tag }, GridPoint: { Row: row, Column: column }, CanvasPosition: { X: 10.12345, Y: 20 } });
  const exports: RawExport[] = [
    {
      Type: "WDUIMetaTreePresetDataAsset",
      Properties: {
        TreePresets: [
          { Key: { TagName: "Meta.Role.Medic" }, Value: { GridPreset: { GridType: "EWDUIMetaTreeGridType::Circle", Rows: 4, Columns: 9 }, NodePresets: [preset("Meta.Role.Medic.Fast", 1, 2), { EntryID: { TagName: "None" } }] } },
        ],
      } as never,
    },
  ];

  it("reads each role's grid and each placed skill's row, column and canvas position", () => {
    const { layout, trees } = parseSkillLayout(exports);
    expect(trees).toEqual([{ role: "Medic", rows: 4, columns: 9, shape: "Circle" }]);
    expect([...layout]).toEqual([["Meta.Role.Medic.Fast", { row: 1, column: 2, x: 10.123, y: 20 }]]);
  });
});

describe("nodeOnlySkills", () => {
  it("lists skills the tree names that no effects table covers, with no effects", () => {
    const nodes = new Map([
      ["Meta.Role.Medic.Fast", { name: "Fast" }],
      ["Meta.Role.Medic.MedicBag", { name: "Bag", description: "A bag." }],
    ]);
    expect(nodeOnlySkills(nodes, new Set(["Medic.Fast"]))).toEqual([{ id: "Medic.MedicBag", role: "Medic", name: "Bag", description: "A bag.", effects: [] }]);
  });
});

describe("parseSkills", () => {
  const curveTable: RawExport[] = [{ Type: "CurveTable", Rows: { Fast: { Keys: [{ Time: 0, Value: 1 }, { Time: 2, Value: 0.8 }] } } as never }];
  const index = { load: (path: string | null | undefined) => (path === "/Game/Meta/CT_Test.0" ? curveTable : undefined) };
  const row = (entries: unknown[]) => ({ SkillEffects: [{ Key: { TagName: "Meta.Skill.Character" }, Value: { SkillEffects: entries } }] });

  it("joins a leveled effect with its curve, and keeps a plain ability as an effect without levels", () => {
    const skills = parseSkills(
      table("WDMetaSkillEffectsTaggedTableRow", {
        "Meta.Role.Infantry.Sprint": row([
          {
            Effect: { ObjectName: "BlueprintGeneratedClass'GE_Speed_C'" },
            CustomMagnitudes: [{ Key: { TagName: "Attribute.Gameplay.Movement.MaxSpeedMultiplier" }, Value: { Value: 1, Curve: { CurveTable: { ObjectPath: "/Game/Meta/CT_Test.0" }, RowName: "Fast" } } }],
          },
        ]),
        "Meta.Role.Infantry.Breach": row([{ Effect: { ObjectName: "BlueprintGeneratedClass'GE_Breach_C'" }, CustomMagnitudes: [] }]),
      }),
      new Map([["Meta.Role.Infantry.Sprint", { name: "Sprint", description: "Run." }]]),
      index,
    );
    expect(skills).toEqual([
      {
        id: "Infantry.Sprint",
        role: "Infantry",
        name: "Sprint",
        description: "Run.",
        effects: [{ trigger: "Character", effect: "GE_Speed", attribute: "Movement.MaxSpeedMultiplier", curve: "Fast", levels: [{ level: 0, value: 1 }, { level: 2, value: 0.8 }] }],
      },
      { id: "Infantry.Breach", role: "Infantry", effects: [{ trigger: "Character", effect: "GE_Breach" }] },
    ]);
  });

  it("keeps the curve name when the curve table is not in the cache", () => {
    const [skill] = parseSkills(
      table("WDMetaSkillEffectsTaggedTableRow", {
        "Meta.Role.Medic.X": row([{ Effect: { ObjectName: "BlueprintGeneratedClass'GE_X_C'" }, CustomMagnitudes: [{ Key: { TagName: "Attribute.Gameplay.A" }, Value: { Curve: { CurveTable: { ObjectPath: "/Game/Nope.0" }, RowName: "Gone" } } }] }]),
      }),
      new Map(),
      index,
    );
    expect(skill?.effects).toEqual([{ trigger: "Character", effect: "GE_X", attribute: "A", curve: "Gone" }]);
  });
});

describe("parseRewards", () => {
  it("separates the base amount from the named modifiers, and drops the prefixes", () => {
    const rewards = parseRewards(
      "PlayerKill",
      table("WDCustomRewardTableRow", {
        "Meta.Progression.Context.DefaultReward": { Description: { LocalizedString: "A kill" }, ResourceTag: { TagName: "Attribute.Meta.Currency.Cash" }, base: 250, FriendlyModifier: -6, ModifierCZ: 4, Tag: { TagName: "x" } },
        "Vehicle.Variant.Test": { ResourceTag: { TagName: "Attribute.Meta.Currency.Cash" }, base: 5000, OwnerModifier: 1 },
        NoBase: { ResourceTag: { TagName: "Attribute.Meta.Currency.Cash" } },
      }),
    );
    expect(rewards).toEqual([
      { action: "PlayerKill", context: "DefaultReward", description: "A kill", resource: "Cash", base: 250, modifiers: { FriendlyModifier: -6, ModifierCZ: 4 } },
      { action: "PlayerKill", context: "Vehicle.Variant.Test", resource: "Cash", base: 5000, modifiers: { OwnerModifier: 1 } },
    ]);
  });
});

describe("parseRoles", () => {
  const mastery = (rows: Record<string, unknown>) => table("WDMetaMasteryDefinitionTableRow", rows);

  it("reads each role's XP per level, sorted, with the role prefix and attribute prefix removed", () => {
    const roles = parseRoles(
      mastery({
        "Meta.Role.Medic": { ResourceTag: { TagName: "Attribute.Meta.XP.Role.Medic" }, LevelDefinitions: [{ Level: 1, XP: 200, Rewards: [] }, { Level: 0, XP: 0, Rewards: [] }, { Level: 2, XP: 750, Rewards: [] }] },
        "Meta.Role.Driver": { ResourceTag: { TagName: "Attribute.Meta.XP.Role.Driver" }, LevelDefinitions: [{ Level: 0, XP: 0, Rewards: [] }] },
      }),
    );
    expect(roles).toEqual([
      { id: "Driver", xpResource: "XP.Role.Driver", levels: [{ level: 0, xp: 0 }] },
      { id: "Medic", xpResource: "XP.Role.Medic", levels: [{ level: 0, xp: 0 }, { level: 1, xp: 200 }, { level: 2, xp: 750 }] },
    ]);
  });

  it("skips rows without a resource and levels without numbers, and reports levels that grant rewards", () => {
    const seen: string[] = [];
    const roles = parseRoles(
      mastery({
        "Meta.Role.A": { LevelDefinitions: [{ Level: 0, XP: 0 }] },
        "Meta.Role.B": { ResourceTag: { TagName: "Attribute.Meta.XP.Role.B" }, LevelDefinitions: [{ Level: 0, XP: 0, Rewards: [] }, { Level: 1, Rewards: [] }, { Level: 2, XP: 5, Rewards: [{}] }] },
      }),
      (role, level) => seen.push(`${role} ${level}`),
    );
    expect(roles.map((r) => r.id)).toEqual(["B"]);
    expect(roles[0]!.levels).toEqual([{ level: 0, xp: 0 }, { level: 2, xp: 5 }]);
    expect(seen).toEqual(["B 2"]);
  });

  it("ignores tables of other kinds", () => {
    expect(parseRoles(table("WDCustomRewardTableRow", { "Meta.Role.X": { ResourceTag: { TagName: "Attribute.Meta.XP.Role.X" }, LevelDefinitions: [] } }))).toEqual([]);
  });
});

describe("buildProgressionData", () => {
  it("builds both files from the cache, and the skill curves from the gameplay cache", () => {
    const raw = mkdtempSync(join(tmpdir(), "wardogs-prog-"));
    const put = (path: string, value: unknown) => {
      mkdirSync(dirname(join(raw, path)), { recursive: true });
      writeFileSync(join(raw, path), JSON.stringify(value));
    };
    put("items/Wardogs/Content/UI/DT_CharacterSkillNodes_Data.json", table("WDMetaTreeNodeData_UI", { "Meta.Role.Medic.Fast": { FriendlyName: invariant("Fast") } }));
    put(
      "items/Wardogs/Content/Meta/DT_MedicSkills.json",
      table("WDMetaSkillEffectsTaggedTableRow", {
        "Meta.Role.Medic.Fast": {
          SkillEffects: [{ Key: { TagName: "Meta.Skill.Character" }, Value: { SkillEffects: [{ Effect: { ObjectName: "BlueprintGeneratedClass'GE_F_C'" }, CustomMagnitudes: [{ Key: { TagName: "Attribute.Gameplay.Heal" }, Value: { Curve: { CurveTable: { ObjectPath: "/Game/Meta/CT_MedicSkills.0" }, RowName: "Heal" } } }] }] } }],
        },
      }),
    );
    put("gameplay/Wardogs/Content/Meta/CT_MedicSkills.json", [{ Type: "CurveTable", Rows: { Heal: { Keys: [{ Time: 0, Value: 1 }, { Time: 1, Value: 1.5 }] } } }]);
    put("items/Wardogs/Content/Rewards/DT_Reward_Cash_Heal.json", table("WDCustomRewardTableRow", { "Meta.Progression.Context.DefaultReward": { ResourceTag: { TagName: "Attribute.Meta.Currency.Cash" }, base: 10, FriendlyModifier: 0 } }));
    put(
      "items/Wardogs/Content/Meta/Levels/Roles/DT_RoleMasteryDefinitions.json",
      table("WDMetaMasteryDefinitionTableRow", { "Meta.Role.Medic": { ResourceTag: { TagName: "Attribute.Meta.XP.Role.Medic" }, LevelDefinitions: [{ Level: 0, XP: 0, Rewards: [] }, { Level: 1, XP: 200, Rewards: [] }] } }),
    );
    const { files, notes } = buildProgressionData(raw, "3");
    const skills = SkillsFile.parse(JSON.parse(files.find((f) => f.path === "data/skills.json")!.content));
    const rewards = RewardsFile.parse(JSON.parse(files.find((f) => f.path === "data/rewards.json")!.content));
    expect(skills.skills[0]).toMatchObject({ id: "Medic.Fast", name: "Fast", effects: [{ levels: [{ level: 0, value: 1 }, { level: 1, value: 1.5 }] }] });
    expect(rewards.rewards).toEqual([{ action: "Heal", context: "DefaultReward", resource: "Cash", base: 10, modifiers: { FriendlyModifier: 0 } }]);
    expect(notes[0]).toContain("skills: 1 (1 named, 1 with level curves, 0 without effect data, 0 placed in a tree)");
    expect(RolesFile.parse(JSON.parse(files.find((f) => f.path === "data/roles.json")!.content)).roles).toEqual([
      { id: "Medic", xpResource: "XP.Role.Medic", levels: [{ level: 0, xp: 0 }, { level: 1, xp: 200 }] },
    ]);
    expect(notes).toContain("roles: 1 with 2 levels");
  });
});

describe("progression data", () => {
  const skills = SkillsFile.parse(JSON.parse(readFileSync("data/skills.json", "utf8"))).skills;
  const rewards = RewardsFile.parse(JSON.parse(readFileSync("data/rewards.json", "utf8"))).rewards;
  const items = ItemsFile.parse(JSON.parse(readFileSync("data/items.json", "utf8"))).items;

  it("keeps skills and rewards populated, all six roles present", () => {
    expect(skills.length).toBeGreaterThanOrEqual(50);
    expect(skills.filter((s) => s.effects.some((e) => e.levels)).length).toBeGreaterThanOrEqual(45);
    expect(new Set(skills.map((s) => s.role))).toEqual(new Set(["Infantry", "Support", "Medic", "Recon", "Pilot", "Driver"]));
    expect(new Set(rewards.map((r) => r.action)).size).toBeGreaterThanOrEqual(16);
    expect(rewards.length).toBeGreaterThanOrEqual(100);
  });

  it("covers every skill the game's tree names, placed on each role's grid without two skills in one cell", () => {
    const file = SkillsFile.parse(JSON.parse(readFileSync("data/skills.json", "utf8")));
    expect(file.skills.length).toBeGreaterThanOrEqual(130);
    expect(file.trees.map((t) => [t.role, t.rows, t.columns])).toEqual([["Driver", 4, 9], ["Infantry", 4, 9], ["Medic", 4, 9], ["Pilot", 4, 9], ["Recon", 4, 9], ["Support", 4, 9]]);
    const cells = new Set<string>();
    for (const s of file.skills) {
      if (!s.layout) continue;
      const tree = file.trees.find((t) => t.role === s.role)!;
      expect(s.layout.row, s.id).toBeLessThan(tree.rows);
      expect(s.layout.column, s.id).toBeLessThan(tree.columns);
      const cell = `${s.role}/${s.layout.row}/${s.layout.column}`;
      expect(cells.has(cell), cell).toBe(false);
      cells.add(cell);
    }
    expect(file.skills.filter((s) => !s.layout).map((s) => s.id)).toEqual(["Medic.MedkitUsage"]);
  });

  it("canaries: the grenade skill sits in the innermost ring and has no effect data in the client files", () => {
    const strongArm = skills.find((s) => s.id === "Infantry.StrongArm")!;
    expect(strongArm).toMatchObject({ name: "Increased grenade throw strength", layout: { row: 0, column: 1 }, effects: [] });
  });

  it("names every skill, and gives level curves ascending levels", () => {
    expect(skills.filter((s) => !s.name).map((s) => s.id)).toEqual([]);
    for (const s of skills) for (const e of s.effects) if (e.levels) expect(e.levels.map((l) => l.level), s.id).toEqual([...e.levels.map((l) => l.level)].sort((a, b) => a - b));
  });

  it("uses roles that item unlocks also use", () => {
    const unlockRoles = new Set(items.flatMap((i) => (i.unlock ? [i.unlock.role] : [])));
    for (const role of new Set(skills.map((s) => s.role))) expect(unlockRoles.has(role), role).toBe(true);
  });

  it("canaries: ready-to-fire improves to 0.6 at level 4; a player kill pays a base of 250 cash", () => {
    const rtf = skills.find((s) => s.id === "Infantry.ReturnToFireSpeed.AssaultRifle")!;
    expect(rtf.effects[0]?.levels?.at(-1)).toEqual({ level: 4, value: 0.6 });
    const kill = rewards.find((r) => r.action === "PlayerKill" && r.context === "DefaultReward")!;
    expect(kill).toMatchObject({ resource: "Cash", base: 250 });
    expect(kill.modifiers).toMatchObject({ FriendlyModifier: -6, ModifierCZ: 4, ModifierHZ: 8 });
  });
});

describe("role levels data", () => {
  const roles = RolesFile.parse(JSON.parse(readFileSync("data/roles.json", "utf8"))).roles;
  const items = ItemsFile.parse(JSON.parse(readFileSync("data/items.json", "utf8"))).items;

  it("has the six roles, each with levels 0 to 100 and strictly rising XP", () => {
    expect(roles.map((r) => r.id)).toEqual(["Driver", "Infantry", "Medic", "Pilot", "Recon", "Support"]);
    for (const r of roles) {
      expect(r.levels.map((l) => l.level), r.id).toEqual(Array.from({ length: 101 }, (_, i) => i));
      expect(r.levels[0]!.xp, r.id).toBe(0);
      r.levels.forEach((l, i) => i > 0 && expect(l.xp, `${r.id} level ${l.level}`).toBeGreaterThan(r.levels[i - 1]!.xp));
    }
  });

  it("canaries: values read from the game's table", () => {
    const driver = roles.find((r) => r.id === "Driver")!;
    const xp = (level: number) => driver.levels.find((l) => l.level === level)!.xp;
    expect([xp(1), xp(10), xp(26), xp(50), xp(100)]).toEqual([200, 25000, 225600, 1150000, 5132500]);
    expect(driver.xpResource).toBe("XP.Role.Driver");
  });

  it("covers every item unlock level of the six roles (the Wardog career level has no table)", () => {
    const top = new Map(roles.map((r) => [r.id, r.levels.at(-1)!.level]));
    for (const i of items) {
      if (!i.unlock || i.unlock.role === "Wardog") continue;
      expect(top.get(i.unlock.role), i.id).toBeGreaterThanOrEqual(i.unlock.level);
    }
  });
});
