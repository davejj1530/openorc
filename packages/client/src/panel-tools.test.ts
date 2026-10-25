import { describe, expect, it } from "vitest";
import { WORKSPACE_ID } from "@openorc/protocol";
import { panelToolLabels, tabsFor } from "./panel-tools.js";

const project = { id: "project" };
const thread = { worktreePath: null, branch: null, orclingId: null };

describe("a side panel's tools", () => {
  it("offers a project thread the Git tools, and a Workspace thread none", () => {
    expect(tabsFor({ kind: "thread", thread, project })).toEqual(["changes", "terminal", "file", "plan", "tasks", "checkpoints", "commits", "memory", "instructions"]);
    expect(tabsFor({ kind: "thread", thread, project: { id: WORKSPACE_ID } })).toEqual(["terminal", "file", "tasks", "plan", "memory", "instructions"]);
  });

  it("drops Commits for a pull request's detached copy, and adds an Orcling's own tool", () => {
    expect(tabsFor({ kind: "thread", thread: { worktreePath: "/w/pr-7", branch: null, orclingId: null }, project })).not.toContain("commits");
    expect(tabsFor({ kind: "thread", thread: { ...thread, orclingId: "gloop" }, project }).at(-1)).toBe("orcling");
  });

  it("offers tasks, projects and new threads their own tools", () => {
    expect(tabsFor({ kind: "task", project })).toEqual(["changes", "terminal", "file", "task", "commits", "memory"]);
    expect(tabsFor({ kind: "task", project: { id: WORKSPACE_ID } })).toEqual(["terminal", "file", "task", "memory"]);
    expect(tabsFor({ kind: "project", project })).toEqual(["changes", "file"]);
    expect(tabsFor({ kind: "newthread", project, changes: true })).toEqual(["changes", "terminal", "file", "commits", "memory"]);
    expect(tabsFor({ kind: "newthread", project, changes: false })).toEqual(["terminal", "file", "memory"]);
  });

  it("names each tool as the desktop does", () => {
    expect(panelToolLabels).toMatchObject({ changes: "Changes", commits: "Commits", browser: "Preview", file: "Files", terminal: "Terminal" });
  });
});
