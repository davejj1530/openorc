import path from "node:path";
import { expect, it } from "vitest";
import { claudeStateFile } from "./shared-mcp.js";

const home = path.join(path.sep, "home", "person");

it("finds the state of Claude's default folder beside it, in the home folder", () => {
  expect(claudeStateFile(path.join(home, ".claude"), home)).toBe(path.join(home, ".claude.json"));
});

it("finds the state of any other Claude folder inside it", () => {
  const account = path.join(home, "data", "claude-accounts", "work");
  expect(claudeStateFile(account, home)).toBe(path.join(account, ".claude.json"));
  expect(claudeStateFile(path.join(home, "elsewhere", ".claude"), home)).toBe(path.join(home, "elsewhere", ".claude", ".claude.json"));
});
