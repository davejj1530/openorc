import { Db, projects, threads } from "@openorc/db";
import { afterEach, beforeEach, expect, it } from "vitest";
import { RunBriefs } from "./run-briefs.js";

let db: Db;

beforeEach(() => {
  db = Db.memory();
});
afterEach(() => db.close());

it("tells a thread's agent the worktree it works in, and its branch", () => {
  const project = projects.insert(db, { name: "acme", rootPath: "/Users/me/acme", gitRemote: null, defaultBranch: "main", settings: { setupScript: null, worktreeInclude: [] } });
  const inserted = threads.insert(db, { projectId: project.id, title: "What branch are you on", agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
  const thread = threads.update(db, inserted.id, { worktreePath: "/Users/me/data/worktrees/acme/thread-what-branch", branch: "openorc/what-branch" });
  const briefs = new RunBriefs(db, { brief: () => "" });
  expect(briefs.threadBrief(thread, project, "act")).toContain("working in this thread's own worktree at /Users/me/data/worktrees/acme/thread-what-branch on branch openorc/what-branch.");
});
