import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexSkillRows } from "./skills.js";

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("Codex skill rows", () => {
  it("keeps every invocation ID, turned off or not, and maps Codex's scopes", async () => {
    const rows = await codexSkillRows([
      { name: "review", description: "Review\nchanges", path: "/project/.agents/skills/review/SKILL.md", scope: "repo", enabled: true },
      { name: "plugin:design", description: "Design", path: "/plugin/design/SKILL.md", scope: "user", pluginId: "plugin@market", enabled: true },
      { name: "system", description: "Bundled", path: "/system/SKILL.md", scope: "system", enabled: true },
      { name: "managed", description: "Set by an administrator", path: "/etc/codex/skills/managed/SKILL.md", scope: "admin", enabled: true },
      { name: "disabled", description: "", path: "/home/.agents/skills/disabled/SKILL.md", scope: "user", enabled: false },
    ]);
    expect(rows).toEqual([
      { name: "disabled", description: "", path: "/home/.agents/skills/disabled/SKILL.md", source: "user", enabled: false, editable: true },
      { name: "managed", description: "Set by an administrator", path: "/etc/codex/skills/managed/SKILL.md", source: "system", enabled: true, editable: false },
      { name: "plugin:design", description: "Design", path: "/plugin/design/SKILL.md", source: "plugin", enabled: true, editable: false },
      { name: "review", description: "Review changes", path: "/project/.agents/skills/review/SKILL.md", source: "project", enabled: true, editable: true },
      { name: "system", description: "Bundled", path: "/system/SKILL.md", source: "system", enabled: true, editable: false },
    ]);
  });

  it("shows the interface Codex read, with its small image, and no image from outside the skill's folder", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openorc-codex-skill-"));
    temps.push(root);
    const folder = path.join(root, "imagegen");
    await mkdir(path.join(folder, "assets"), { recursive: true });
    await writeFile(path.join(folder, "assets", "small.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await mkdir(path.join(root, "other"));
    await writeFile(path.join(root, "outside.png"), "png");
    const [shown, escaped] = await codexSkillRows([
      {
        name: "imagegen",
        description: "Generate images",
        path: path.join(folder, "SKILL.md"),
        scope: "system",
        enabled: true,
        interface: { displayName: "Image Gen", shortDescription: "Make images", iconSmall: path.join(folder, "assets", "small.svg"), iconLarge: path.join(folder, "assets", "missing.png") },
      },
      {
        name: "outside",
        description: "",
        path: path.join(root, "other", "SKILL.md"),
        scope: "user",
        enabled: true,
        shortDescription: "Legacy line",
        interface: { iconLarge: path.join(root, "outside.png") },
      },
    ]);
    expect(shown).toMatchObject({
      displayName: "Image Gen",
      shortDescription: "Make images",
      icon: `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64")}`,
    });
    expect(escaped).toMatchObject({ shortDescription: "Legacy line" });
    expect(escaped).not.toHaveProperty("icon");
  });
});
