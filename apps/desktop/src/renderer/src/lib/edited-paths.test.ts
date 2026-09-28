import { describe, expect, it } from "vitest";
import { editedPaths } from "./edited-paths";

describe("editedPaths", () => {
  it("names the file of a Claude edit relative to the workspace", () => {
    expect(editedPaths("Edit", { file_path: "/repo/src/a.ts", old_string: "x", new_string: "y" }, "/repo")).toEqual(["src/a.ts"]);
    expect(editedPaths("Write", { file_path: "/elsewhere/b.ts" }, "/repo/")).toEqual(["/elsewhere/b.ts"]);
  });

  it("reads every file in a Codex apply_patch input once", () => {
    const patch = ["*** Begin Patch", "*** Update File: src/a.ts", "@@", "-x", "+y", "*** Add File: src/b.ts", "+z", "*** Update File: src/a.ts", "*** End Patch"].join("\n");
    expect(editedPaths("apply_patch", { input: patch })).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("ignores tools that do not write", () => {
    expect(editedPaths("Read", { file_path: "/repo/src/a.ts" }, "/repo")).toEqual([]);
    expect(editedPaths("Bash", { command: "rm src/a.ts" })).toEqual([]);
  });

  it("handles the MCP tool name prefix and list-shaped input", () => {
    expect(editedPaths("mcp__fs__write_file", { path: "docs/x.md" })).toEqual(["docs/x.md"]);
    expect(editedPaths("multiedit", [{ path: "a.ts" }, { path: "b.ts" }, { path: "a.ts" }])).toEqual(["a.ts", "b.ts"]);
  });
});
