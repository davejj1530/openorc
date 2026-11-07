import { cloudWorkspaces, Db, projects, threads } from "@openorc/db";
import { afterEach, beforeEach, expect, it } from "vitest";
import { RunBriefs } from "./run-briefs.js";

let db: Db;

beforeEach(() => {
  db = Db.memory();
});
afterEach(() => db.close());

it("tells a cloud thread's agent it works in its sandbox's copy, not at the worktree's path on the machine that keeps it", () => {
  const project = projects.insert(db, { name: "acme", rootPath: "/Users/me/acme", gitRemote: null, defaultBranch: "main", settings: { setupScript: null, worktreeInclude: [] } });
  const inserted = threads.insert(db, { projectId: project.id, title: "What branch are you on", agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
  const thread = threads.update(db, inserted.id, { worktreePath: "/home/node/openorc-brain/data/worktrees/acme/thread-what-branch", branch: "openorc/what-branch" });
  const briefs = new RunBriefs(db, { brief: () => "" });
  const local = briefs.threadBrief(thread, project, "act");
  expect(local).toContain("working in this thread's own worktree at /home/node/openorc-brain/data/worktrees/acme/thread-what-branch on branch openorc/what-branch.");

  cloudWorkspaces.insert(db, { threadId: thread.id, provider: "agent37", sandbox: "openorc-what-branch" });
  const cloud = briefs.threadBrief(thread, project, "act");
  expect(cloud).toContain("working in this thread's cloud sandbox: your current working directory is its copy of the project, on branch openorc/what-branch.");
  expect(cloud).not.toContain("/home/node/openorc-brain");

  // With its sandbox deleted, the brief names no sandbox.
  cloudWorkspaces.removed(db, thread.id);
  expect(briefs.threadBrief(thread, project, "act")).toContain("own worktree at /home/node/openorc-brain");
});
