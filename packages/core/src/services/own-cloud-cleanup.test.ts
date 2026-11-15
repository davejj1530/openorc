import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Db, projects, settings, threads } from "@openorc/db";
import { commitAll, git, worktree } from "@openorc/git";
import type { Project, Thread } from "@openorc/protocol";
import { removedBrains } from "../remote/removed-brains.js";
import { BrainMirrors, snapshotFolder } from "./brain-mirrors.js";
import { removeOwnCloud } from "./own-cloud-cleanup.js";

let root: string;
let dataDir: string;
let db: Db;
let project: Project;
let sandboxed: Thread;
let moving: Thread;
let logged: string[];

const log = { info: (message: string) => void logged.push(message), warn: (message: string) => void logged.push(message), error: (message: string) => void logged.push(message) };
const count = (table: string) => Number((db.stmt(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
const own = ["cloud-credentials.enc", "claude-cloud-tokens.enc", "codex-cloud-login.enc", "opencode-cloud-keys.enc", "cloud-env.enc", "cloud-brain.enc", "cloud-brain-move.enc"];
const others = ["remote-access-key.enc", "apns-key.enc", "openorc-account.enc"];

/** A profile as the own cloud left one: a sandbox thread, a thread frozen mid-move, a brain's copy open here, its stores and kept lists. */
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-own-cloud-")));
  dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  logged = [];
  const checkout = path.join(root, "app");
  await git(root, ["init", "-q", "-b", "main", checkout]);
  writeFileSync(path.join(checkout, "README.md"), "# App\n");
  await commitAll(checkout, "Baseline");
  db = Db.memory();
  project = projects.insert(db, { name: "app", rootPath: checkout, gitRemote: null, defaultBranch: "main", settings: {} });
  const start = (title: string) => threads.insert(db, { projectId: project.id, title, agent: "claude", model: null, mode: "act", permissionMode: "autonomous", workspaceMode: "worktree" });

  sandboxed = start("Ran in a sandbox");
  const folder = path.join(dataDir, "worktrees", "sandboxed");
  await worktree.add(checkout, { path: folder, branch: "openorc/sandboxed", startPoint: "main" });
  writeFileSync(path.join(folder, "synced.md"), "as of the last sync\n");
  sandboxed = threads.update(db, sandboxed.id, { worktreePath: folder, branch: "openorc/sandboxed" });
  db.stmt("INSERT INTO cloud_workspaces (thread_id, provider, sandbox, state, mirror_tree, created_at, updated_at) VALUES (?, 'vercel', 'openorc-sandboxed', 'ready', 'tree', 1, 1)").run(sandboxed.id);

  moving = start("Frozen by a move");
  db.stmt("INSERT INTO thread_relocations (id, thread_id, role, direction, phase, created_at, updated_at) VALUES ('r1', ?, 'coordinator', 'to-cloud', 'sending', 1, 1)").run(moving.id);
  db.stmt("INSERT INTO thread_relocations (id, thread_id, role, direction, phase, created_at, updated_at) VALUES ('r0', ?, 'coordinator', 'to-mac', 'done', 1, 1)").run(sandboxed.id);
  db.stmt("INSERT INTO memory_tombstones (id, project_id, removed_at) VALUES ('m1', ?, 1)").run(project.id);

  // A brain's thread open on this Mac, as Open on Mac left it: a detached worktree of the project under data/mirrors.
  const far = path.join(root, "far");
  await git(root, ["clone", "-q", checkout, far]);
  const copies = new BrainMirrors({
    db,
    dataDir,
    snapshot: (threadId, known) => snapshotFolder(far, far, threadId, known),
    thread: async () => ({ projectId: "far", baseSha: null }),
    macProject: async () => project.id,
    changed: () => {},
    log,
  });
  await copies.open("brain-thread");

  for (const file of [...own, ...others]) writeFileSync(path.join(dataDir, file), "sealed");
  for (const kept of ["cloud-sandboxes/openorc-x/repo", "kept-sessions/t1/r1"]) mkdirSync(path.join(dataDir, kept), { recursive: true });
  mkdirSync(path.join(dataDir, "attachments"));
  for (const [key, value] of [
    ["brain.pages", "{}"],
    ["brain.memory", "{}"],
    ["brain.leaving", "1"],
    ["brain.removed", JSON.stringify(["removed-brain-key"])],
    ["cloud.skills", "{}"],
    ["cloud.bases", "{}"],
    ["cloud.brain.phones", "[]"],
    ["mac.backlog", "null"],
    ["remote.access", JSON.stringify({ enabled: true, port: 47820 })],
    ["memory.enabled", "true"],
  ] as const)
    settings.set(db, key, value);
});

afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

const worktrees = async () => (await git(project.rootPath, ["worktree", "list", "--porcelain"])).stdout;

it("leaves a profile the own cloud used with plain threads on this Mac, and nothing of the cloud but the removed brains", async () => {
  const mirror = path.join(dataDir, "mirrors", "brain-thread");
  expect(existsSync(mirror)).toBe(true);

  await removeOwnCloud(db, dataDir, log);

  // The sandbox thread is a worktree thread: same folder, branch and files, and no sandbox behind it.
  expect(count("cloud_workspaces")).toBe(0);
  expect(threads.get(db, sandboxed.id)).toMatchObject({ workspaceMode: "worktree", worktreePath: sandboxed.worktreePath, branch: "openorc/sandboxed" });
  expect(existsSync(path.join(sandboxed.worktreePath!, "synced.md"))).toBe(true);
  // The frozen thread is released, and still here.
  expect(count("thread_relocations")).toBe(0);
  expect(threads.get(db, moving.id)).not.toBeNull();
  expect(count("memory_tombstones")).toBe(0);

  for (const file of own) expect(existsSync(path.join(dataDir, file)), file).toBe(false);
  for (const file of others) expect(existsSync(path.join(dataDir, file)), file).toBe(true);
  for (const folder of ["cloud-sandboxes", "kept-sessions", "mirrors"]) expect(existsSync(path.join(dataDir, folder)), folder).toBe(false);
  expect(existsSync(path.join(dataDir, "attachments"))).toBe(true);
  // The brain's copy is gone from the project's worktrees too; the sandbox thread's worktree stays.
  expect(await worktrees()).not.toContain(mirror);
  expect(await worktrees()).toContain(sandboxed.worktreePath!);

  const keys = (db.stmt("SELECT key FROM settings ORDER BY key").all() as { key: string }[]).map((row) => row.key);
  expect(keys).toEqual(["brain.removed", "memory.enabled", "own-cloud.removed", "remote.access"]);
  expect(removedBrains(db)).toEqual(["removed-brain-key"]);
  expect(logged.filter((line) => line.includes("ran in your own cloud"))).toEqual([
    "1 thread that ran in your own cloud now works in a worktree on this Mac, with the code as of the last sync. What a sandbox changed after that did not come along.",
  ]);
});

it("runs once: a second start changes nothing and says nothing", async () => {
  await removeOwnCloud(db, dataDir, log);
  const first = { logged: [...logged], settings: db.stmt("SELECT key, value FROM settings ORDER BY key").all(), threads: threads.list(db, {}).map((thread) => thread.id) };
  // What a later feature keeps under a name the own cloud used is not this cleanup's to take.
  mkdirSync(path.join(dataDir, "mirrors", "later"), { recursive: true });
  settings.set(db, "cloud.later", "kept");

  await removeOwnCloud(db, dataDir, log);

  expect(logged).toEqual(first.logged);
  expect(threads.list(db, {}).map((thread) => thread.id)).toEqual(first.threads);
  expect(existsSync(path.join(dataDir, "mirrors", "later"))).toBe(true);
  expect(settings.get(db, "cloud.later")).toBe("kept");
  expect(count("cloud_workspaces")).toBe(0);
});

it("does nothing but note that it ran in a profile the own cloud never touched", async () => {
  const fresh = Db.memory();
  const empty = path.join(root, "empty");
  mkdirSync(empty);
  try {
    await removeOwnCloud(fresh, empty, log);
    await removeOwnCloud(fresh, empty, log);
    expect((fresh.stmt("SELECT key FROM settings").all() as { key: string }[]).map((row) => row.key)).toEqual(["own-cloud.removed"]);
  } finally {
    fresh.close();
  }
  expect(logged).toEqual([]);
});
