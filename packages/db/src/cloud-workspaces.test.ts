import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cloudWorkspaces } from "./cloud-workspaces.js";
import { Db } from "./database.js";
import { projects, threads } from "./repos.js";

let db: Db;
let threadId: string;

beforeEach(() => {
  db = Db.memory();
  const project = projects.insert(db, { name: "Fixture", rootPath: "/tmp/fixture", gitRemote: null, defaultBranch: "main", settings: { setupScript: null, worktreeInclude: [] } });
  threadId = threads.insert(db, { projectId: project.id, title: "Cloud", agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" }).id;
});

afterEach(() => db.close());

describe("cloudWorkspaces", () => {
  it("starts preparing with no mirror, and records the mirror once ready", () => {
    expect(cloudWorkspaces.insert(db, { threadId, provider: "local", sandbox: "openorc-a", at: 1 })).toEqual({
      threadId,
      provider: "local",
      sandbox: "openorc-a",
      state: "preparing",
      error: null,
      mirror: null,
      createdAt: 1,
      updatedAt: 1,
    });
    const mirror = { snapshot: null, tree: "t".repeat(40), head: "c".repeat(40), known: ["c".repeat(40)] };
    expect(cloudWorkspaces.ready(db, threadId, mirror, 2)).toMatchObject({ state: "ready", mirror, updatedAt: 2 });
    expect(cloudWorkspaces.get(db, threadId)?.mirror).toEqual(mirror);
  });

  it("records a failure only before the workspace is ready", () => {
    cloudWorkspaces.insert(db, { threadId, provider: "local", sandbox: "openorc-a" });
    cloudWorkspaces.failed(db, threadId, "setup failed");
    expect(cloudWorkspaces.get(db, threadId)).toMatchObject({ state: "failed", error: "setup failed" });
    cloudWorkspaces.ready(db, threadId, { snapshot: null, tree: "t".repeat(40), head: null, known: [] });
    cloudWorkspaces.failed(db, threadId, "late failure");
    expect(cloudWorkspaces.get(db, threadId)).toMatchObject({ state: "ready", error: null });
  });

  it("forgets the mirror when the sandbox is removed, and prepares again from there", () => {
    cloudWorkspaces.insert(db, { threadId, provider: "vercel", sandbox: "openorc-a" });
    cloudWorkspaces.ready(db, threadId, { snapshot: "s".repeat(40), tree: "t".repeat(40), head: "c".repeat(40), known: ["c".repeat(40)] });
    cloudWorkspaces.removed(db, threadId);
    expect(cloudWorkspaces.get(db, threadId)).toMatchObject({ state: "removed", error: null, mirror: null });
    expect(cloudWorkspaces.listByProvider(db, "vercel").map((record) => record.sandbox)).toEqual(["openorc-a"]);
    expect(cloudWorkspaces.listByProvider(db, "local")).toEqual([]);
    cloudWorkspaces.preparing(db, threadId);
    expect(cloudWorkspaces.get(db, threadId)).toMatchObject({ state: "preparing" });
  });

  it("refuses a ready workspace without a mirror and goes with its thread", () => {
    cloudWorkspaces.insert(db, { threadId, provider: "local", sandbox: "openorc-a" });
    expect(() => db.stmt("UPDATE cloud_workspaces SET state = 'ready' WHERE thread_id = ?").run(threadId)).toThrow(/CHECK constraint/);
    db.stmt("DELETE FROM threads WHERE id = ?").run(threadId);
    expect(cloudWorkspaces.get(db, threadId)).toBeNull();
  });
});
