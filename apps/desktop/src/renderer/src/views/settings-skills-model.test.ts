import { expect, it } from "vitest";
import type { AgentSkill } from "@openorc/protocol";
import { skillFolder, skillTree, skillTrigger, splitFrontmatter } from "./settings-skills-model";

const skill = (extra: Partial<AgentSkill> = {}): AgentSkill => ({ name: "research", description: "", source: "user", path: "/Users/me/.claude/skills/research/SKILL.md", ...extra });

it("reads how a skill starts from the agent's own settings", () => {
  expect(skillTrigger("claude", skill(), "---\nname: research\n---\n")).toEqual({ call: "/research", auto: true });
  expect(skillTrigger("claude", skill(), "---\ndisable-model-invocation: true\n---\n")).toEqual({ call: "/research", auto: false });
  expect(skillTrigger("claude", skill(), "---\nuser-invocable: false\n---\n")).toEqual({ call: null, auto: true });
  expect(skillTrigger("codex", skill(), "policy:\n  allow_implicit_invocation: false\n")).toEqual({ call: "$research", auto: false });
  expect(skillTrigger("codex", skill(), "")).toEqual({ call: "$research", auto: true });
  expect(skillTrigger("opencode", skill(), "")).toEqual({ call: null, auto: true });
});

it("leaves the header out of the text it previews", () => {
  expect(splitFrontmatter('---\nname: research\ndescription: "Find sources"\n---\n\n# Research\n')).toEqual({ fields: { name: "research", description: "Find sources" }, body: "# Research\n" });
  expect(splitFrontmatter("# No header\n")).toEqual({ fields: {}, body: "# No header\n" });
});

it("puts the main file first, then folders, then files, each folder holding its own", () => {
  const tree = skillTree(
    [
      { path: "notes.md", kind: "file" },
      { path: "scripts", kind: "directory" },
      { path: "SKILL.md", kind: "file" },
      { path: "references", kind: "directory" },
      { path: "references/sources.md", kind: "file" },
    ],
    "SKILL.md",
  );
  expect(tree.map((entry) => entry.path)).toEqual(["SKILL.md", "references", "scripts", "notes.md"]);
  expect(tree[1]?.children.map((entry) => entry.name)).toEqual(["sources.md"]);
});

it("shows the folder with the home folder as ~", () => {
  expect(skillFolder(skill())).toBe("~/.claude/skills/research");
  expect(skillFolder(skill({ path: "/srv/team/skills/research/SKILL.md" }))).toBe("/srv/team/skills/research");
});
