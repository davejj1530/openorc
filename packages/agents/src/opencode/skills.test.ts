import { describe, expect, it } from "vitest";
import { openCodeSkillRows } from "./skills.js";

describe("OpenCode catalog mapping", () => {
  it("uses the registered ID, includes built-ins, and preserves a discovered source", () => {
    const rows = openCodeSkillRows(
      [
        { id: "report", description: "  Report\n a bug. ", path: "/builtin/report.md" },
        { id: "release", description: "Ship the release.", path: "/project/.opencode/skills/release/SKILL.md" },
        { id: "bad", path: null },
      ],
      new Map([["/project/.opencode/skills/release/SKILL.md", "project"]]),
      "/home/user",
    );
    expect(rows).toEqual([
      { name: "release", description: "Ship the release.", path: "/project/.opencode/skills/release/SKILL.md", source: "project" },
      { name: "report", description: "Report a bug.", path: "/builtin/report.md", source: "system" },
    ]);
  });
});
