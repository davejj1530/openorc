import path from "node:path";
import { describe, expect, it } from "vitest";
import { instructionFiles } from "./instructions.js";

const home = path.join(path.sep, "home", "me");
const folder = path.join(path.sep, "work", "app");
const paths = (agent: Parameters<typeof instructionFiles>[0]["agent"], env: NodeJS.ProcessEnv = {}) => instructionFiles({ agent, folder, home, env });

describe("instructionFiles", () => {
  it("puts the folder's AGENTS.md first and the agent's personal file last", () => {
    expect(paths("claude")).toEqual([
      { scope: "project", path: path.join(folder, "AGENTS.md") },
      { scope: "project", path: path.join(folder, "CLAUDE.md") },
      { scope: "personal", path: path.join(home, ".claude", "CLAUDE.md") },
    ]);
    expect(paths("codex")).toEqual([
      { scope: "project", path: path.join(folder, "AGENTS.md") },
      { scope: "personal", path: path.join(home, ".codex", "AGENTS.md") },
    ]);
    expect(paths("opencode")).toEqual([
      { scope: "project", path: path.join(folder, "AGENTS.md") },
      { scope: "personal", path: path.join(home, ".config", "opencode", "AGENTS.md") },
    ]);
  });

  it("follows each agent's own settings folder", () => {
    const settings = path.join(path.sep, "settings");
    expect(paths("claude", { CLAUDE_CONFIG_DIR: settings }).at(-1)?.path).toBe(path.join(settings, "CLAUDE.md"));
    expect(paths("codex", { CODEX_HOME: settings }).at(-1)?.path).toBe(path.join(settings, "AGENTS.md"));
    expect(paths("opencode", { XDG_CONFIG_HOME: settings }).at(-1)?.path).toBe(path.join(settings, "opencode", "AGENTS.md"));
  });

  it("assumes no personal file for other ACP agents", () => {
    expect(paths("acp")).toEqual([{ scope: "project", path: path.join(folder, "AGENTS.md") }]);
  });
});
