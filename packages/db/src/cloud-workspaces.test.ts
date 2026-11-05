import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cloudWorkspaceAgent37Migration, cloudWorkspaceSessionBaseMigration } from "./cloud-workspace-schema.js";
import { cloudWorkspaces } from "./cloud-workspaces.js";
import { Db } from "./database.js";
import { projects, threads } from "./repos.js";
import { migrations } from "./schema.js";

let db: Db;
let threadId: string;

beforeEach(() => {
  db = Db.memory();
  const project = projects.insert(db, { name: "Fixture", rootPath: "/tmp/fixture", gitRemote: null, defaultBranch: "main", settings: { setupScript: null, worktreeInclude: [] } });
  threadId = threads.insert(db, { projectId: project.id, title: "Cloud", agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" }).id;
});

afterEach(() => db.close());

describe("cloudWorkspaces", () => {
  it("reads a cloud conversation made before the session base as having none, its sandbox and mirror as they were", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openorc-session-base-migration-"));
    const file = path.join(dir, "old.sqlite");
    try {
      const raw = new DatabaseSync(file);
      const before = migrations.indexOf(cloudWorkspaceSessionBaseMigration);
      for (const migration of migrations.slice(0, before)) {
        if (typeof migration === "string") raw.exec(migration);
        else migration(raw);
      }
      raw.exec(`PRAGMA user_version = ${before}`);
      const old = new Db(raw);
      const project = projects.insert(old, { name: "Existing", rootPath: dir, gitRemote: null, defaultBranch: "main", settings: {} });
      const thread = threads.insert(old, { projectId: project.id, title: "In the cloud", agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
      raw
        .prepare(
          "INSERT INTO cloud_workspaces (thread_id, provider, sandbox, state, mirror_tree, mirror_head, mirror_known, created_at, updated_at) VALUES (?, 'vercel', ?, 'ready', ?, ?, '[]', 1, 2)",
        )
        .run(thread.id, `openorc-${thread.id}`, "t".repeat(40), "c".repeat(40));
      old.close();
      const db = Db.open(file);
      try {
        expect(db.version).toBe(migrations.length);
        expect(cloudWorkspaces.get(db, thread.id)).toMatchObject({ state: "ready", sandbox: `openorc-${thread.id}`, mirror: { tree: "t".repeat(40) }, sessionBase: null });
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps every conversation and what its sandbox got of the session when Agent37 joins the services, and runs again harmlessly", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openorc-agent37-migration-"));
    const file = path.join(dir, "old.sqlite");
    try {
      const raw = new DatabaseSync(file);
      const before = migrations.indexOf(cloudWorkspaceAgent37Migration);
      for (const migration of migrations.slice(0, before)) {
        if (typeof migration === "string") raw.exec(migration);
        else migration(raw);
      }
      raw.exec(`PRAGMA user_version = ${before}`);
      const old = new Db(raw);
      const project = projects.insert(old, { name: "Existing", rootPath: dir, gitRemote: null, defaultBranch: "main", settings: {} });
      const thread = threads.insert(old, { projectId: project.id, title: "On Vercel", agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
      const base = { sessionId: "s-1", host: "h".repeat(64), sandbox: "b".repeat(64) };
      cloudWorkspaces.insert(old, { threadId: thread.id, provider: "vercel", sandbox: "openorc-old", at: 1 });
      cloudWorkspaces.setSessionBase(old, thread.id, base);
      expect(() =>
        cloudWorkspaces.insert(old, {
          threadId: threads.insert(old, { projectId: project.id, title: "x", agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" }).id,
          provider: "agent37",
          sandbox: "openorc-x",
        }),
      ).toThrow();
      old.close();
      const db = Db.open(file);
      try {
        expect(cloudWorkspaces.get(db, thread.id)).toMatchObject({ provider: "vercel", sandbox: "openorc-old", sessionBase: base });
        const next = threads.insert(db, { projectId: project.id, title: "On Agent37", agent: "codex", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
        expect(cloudWorkspaces.insert(db, { threadId: next.id, provider: "agent37", sandbox: "openorc-new" }).provider).toBe("agent37");
        cloudWorkspaceAgent37Migration(db.raw);
        expect(cloudWorkspaces.get(db, next.id)?.provider).toBe("agent37");
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps what the sandbox got of the session until its sandbox is removed", () => {
    cloudWorkspaces.insert(db, { threadId, provider: "vercel", sandbox: "openorc-a", at: 1 });
    const base = { sessionId: "s-1", host: "h".repeat(64), sandbox: "b".repeat(64) };
    cloudWorkspaces.setSessionBase(db, threadId, base);
    expect(cloudWorkspaces.get(db, threadId)?.sessionBase).toEqual(base);
    cloudWorkspaces.removed(db, threadId);
    expect(cloudWorkspaces.get(db, threadId)?.sessionBase).toBeNull();
  });

  it("starts preparing with no mirror, and records the mirror once ready", () => {
    expect(cloudWorkspaces.insert(db, { threadId, provider: "local", sandbox: "openorc-a", at: 1 })).toEqual({
      threadId,
      provider: "local",
      sandbox: "openorc-a",
      state: "preparing",
      error: null,
      mirror: null,
      sessionBase: null,
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
