import { describe, expect, it } from "vitest";
import { codexSkillRows } from "./skills.js";

describe("Codex skill rows", () => {
  it("keeps the enabled invocation IDs and maps Codex's sources", () => {
    expect(
      codexSkillRows([
        { name: "review", description: "Review\nchanges", path: "/project/.agents/skills/review/SKILL.md", scope: "project", enabled: true },
        { name: "plugin:design", description: "Design", path: "/plugin/design/SKILL.md", scope: "user", pluginId: "plugin@market", enabled: true },
        { name: "system", description: "Bundled", path: "/system/SKILL.md", scope: "system", enabled: true },
        { name: "disabled", path: "/disabled/SKILL.md", enabled: false },
      ]),
    ).toEqual([
      { name: "plugin:design", description: "Design", path: "/plugin/design/SKILL.md", source: "plugin" },
      { name: "review", description: "Review changes", path: "/project/.agents/skills/review/SKILL.md", source: "project" },
      { name: "system", description: "Bundled", path: "/system/SKILL.md", source: "system" },
    ]);
  });
});
