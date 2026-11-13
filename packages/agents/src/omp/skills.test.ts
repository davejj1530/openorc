import { describe, expect, it } from "vitest";
import { ompSkillRows } from "./skills.js";

describe("Oh My Pi's skill list", () => {
  it("reads where each skill comes from out of its provider and scope", () => {
    const listed = JSON.stringify({
      skills: [
        { name: "brandkit", description: "Brand  kits\nfor boards", filePath: "/home/me/.agents/skills/brandkit/SKILL.md", source: "agents:user", hide: false },
        { name: "release", description: "Ship it", filePath: "/repo/.omp/skills/release/SKILL.md", source: "native:project" },
        { name: "pdf", description: "PDFs", filePath: "/home/me/.omp/plugins/node_modules/x/skills/pdf/SKILL.md", source: "omp-plugins:user" },
        { name: "broken" },
      ],
      warnings: [],
    });
    expect(ompSkillRows(listed)).toEqual([
      { name: "brandkit", description: "Brand kits for boards", path: "/home/me/.agents/skills/brandkit/SKILL.md", source: "user" },
      { name: "release", description: "Ship it", path: "/repo/.omp/skills/release/SKILL.md", source: "project" },
      { name: "pdf", description: "PDFs", path: "/home/me/.omp/plugins/node_modules/x/skills/pdf/SKILL.md", source: "plugin" },
    ]);
  });

  it("refuses an answer that is not a skill list", () => {
    expect(() => ompSkillRows("{}")).toThrow("did not list its skills");
  });
});
