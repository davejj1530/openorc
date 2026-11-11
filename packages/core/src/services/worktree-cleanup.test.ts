import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Db, projects, tasks, threads } from "@openorc/db";
import { git, worktree } from "@openorc/git";
import type { Project, Thread } from "@openorc/protocol";
import { WorkspaceService } from "./workspace.js";
import { WorkspaceWriters } from "./workspace-writers.js";
import { WorktreeCleanup } from "./worktree-cleanup.js";

let directory: string;
let root: string;
let db: Db;
let project: Project;
let workspaces: WorkspaceService;
let writers: WorkspaceWriters;
let activity: Map<string, "idle" | "running" | "waiting">;
let live: Map<string, { id: string }>;
let closeAndWait: ReturnType<typeof vi.fn<(runId: string) => Promise<void>>>;
let invalidate: ReturnType<typeof vi.fn<(keys: string[]) => void>>;
let cleanup: WorktreeCleanup;

const commit = (cwd: string, message: string) => git(cwd, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", message]);
const gone = (file: string) =>
  access(file).then(
    () => false,
    () => true,
  );

beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-worktree-cleanup-")));
  root = path.join(directory, "example-project");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(root, "README.md"), "# Example\n");
  await git(root, ["add", "README.md"]);
  await commit(root, "Example");
  db = Db.memory();
  project = projects.insert(db, { name: "Example", rootPath: root, gitRemote: null, defaultBranch: "main", settings: { worktreeInclude: [] } });
  writers = new WorkspaceWriters();
  workspaces = new WorkspaceService(db, { dataDir: path.join(directory, "data") }, { info() {}, warn() {}, error() {} }, writers);
  activity = new Map();
  live = new Map();
  closeAndWait = vi.fn<(runId: string) => Promise<void>>(async (runId) => {
    for (const [threadId, run] of live) if (run.id === runId) live.delete(threadId);
  });
  invalidate = vi.fn<(keys: string[]) => void>();
  cleanup = new WorktreeCleanup({
    db,
    workspaces,
    runs: {
      liveRunForThread: (id) => (live.get(id) ?? null) as never,
      liveRunForTask: () => null,
      threadActivity: (id) => activity.get(id) ?? "idle",
      threadBackgroundCommands: () => [],
      closeAndWait,
    },
    writers,
    invalidate,
  });
});

afterEach(async () => {
  await workspaces?.shutdown();
  db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function prepared(title: string): Promise<Thread> {
  const thread = threads.insert(db, { projectId: project.id, title, agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
  return workspaces.prepareThread(thread, project, "main");
}

function forkOf(parent: Thread): Thread {
  const fork = threads.insert(db, {
    projectId: project.id,
    title: `${parent.title} (fork)`,
    agent: "codex",
    model: "fixture",
    mode: "act",
    permissionMode: "trusted",
    workspaceMode: "worktree",
    forkedFromId: parent.id,
  });
  return threads.update(db, fork.id, { worktreePath: parent.worktreePath, branch: parent.branch, baseSha: parent.baseSha, baseBranch: parent.baseBranch });
}

describe("worktree list", () => {
  it("lists one row per folder on disk, with its owner, branch and why it must stay", async () => {
    const kept = await prepared("Kept");
    forkOf(kept);
    const working = await prepared("Working");
    activity.set(working.id, "waiting");
    const vanished = await prepared("Vanished");
    await rm(vanished.worktreePath!, { recursive: true, force: true });
    const promoted = await prepared("Promoted");
    const task = tasks.insert(db, { projectId: project.id, title: "Legacy", spec: null, priority: "none", labels: [], workspaceMode: "worktree", baseRef: "main", parentTaskId: null });
    tasks.update(db, task.id, { worktreePath: promoted.worktreePath, branch: promoted.branch });

    const rows = await cleanup.list();

    expect(rows.map((row) => row.title).sort()).toEqual(["Kept", "Promoted", "Working"]);
    expect(rows.find((row) => row.title === "Kept")).toMatchObject({ owner: { kind: "thread", id: kept.id }, branch: kept.branch, path: kept.worktreePath, projectName: "Example", blocked: null });
    expect(rows.find((row) => row.title === "Kept")!.bytes).toBeGreaterThan(0);
    expect(rows.find((row) => row.title === "Working")?.blocked).toBe("working");
    expect(rows.find((row) => row.title === "Promoted")?.blocked).toBe("shared");
  });
});

describe("worktree removal", () => {
  it("saves uncommitted work to the branch, keeps the thread and branch, and the next prepare brings the files back", async () => {
    const thread = await prepared("Draft");
    await writeFile(path.join(thread.worktreePath!, "draft.ts"), "export const draft = true;\n");

    const result = await cleanup.remove([{ kind: "thread", id: thread.id }]);

    expect(result).toEqual({ removed: [{ kind: "thread", id: thread.id }], failed: [] });
    expect(await gone(thread.worktreePath!)).toBe(true);
    expect((await git(root, ["show", `${thread.branch}:draft.ts`])).stdout).toContain("draft = true");
    const after = threads.get(db, thread.id)!;
    expect(after).toMatchObject({ worktreePath: null, branch: thread.branch });
    expect(await cleanup.list()).toEqual([]);

    const back = await workspaces.prepareThread(after, project, after.baseBranch ?? undefined);
    expect(back.branch).toBe(thread.branch);
    expect(await readFile(path.join(back.worktreePath!, "draft.ts"), "utf8")).toContain("draft = true");
    expect(invalidate).toHaveBeenCalledWith(expect.arrayContaining(["worktrees", "threads", `thread:${thread.id}`]));
  });

  it("refuses a working thread and still removes the others", async () => {
    const working = await prepared("Working");
    activity.set(working.id, "running");
    const idle = await prepared("Idle");

    const result = await cleanup.remove([
      { kind: "thread", id: working.id },
      { kind: "thread", id: idle.id },
    ]);

    expect(result.removed).toEqual([{ kind: "thread", id: idle.id }]);
    expect(result.failed).toEqual([{ owner: { kind: "thread", id: working.id }, message: expect.stringMatching(/In use/) }]);
    expect(await gone(working.worktreePath!)).toBe(false);
    expect(await gone(idle.worktreePath!)).toBe(true);
  });

  it("closes an agent waiting between turns before removing its folder", async () => {
    const thread = await prepared("Resting");
    live.set(thread.id, { id: "run-1" });

    const result = await cleanup.remove([{ kind: "thread", id: thread.id }]);

    expect(closeAndWait).toHaveBeenCalledWith("run-1");
    expect(result.removed).toHaveLength(1);
  });

  it("removes a pull request's review copy without committing anything", async () => {
    const thread = threads.insert(db, { projectId: project.id, title: "Review", agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
    const copy = path.join(directory, "data", "worktrees", "review-copy");
    await mkdir(path.dirname(copy), { recursive: true });
    await worktree.addDetached(root, { path: copy, commit: "main" });
    threads.update(db, thread.id, { worktreePath: copy, branch: null });
    await writeFile(path.join(copy, "edit.ts"), "export const edit = true;\n");
    const before = (await git(root, ["rev-list", "--all", "--count"])).stdout.trim();

    const result = await cleanup.remove([{ kind: "thread", id: thread.id }]);

    expect(result.failed).toEqual([]);
    expect(await gone(copy)).toBe(true);
    expect((await git(root, ["rev-list", "--all", "--count"])).stdout.trim()).toBe(before);
  });

  it("removes a folder forks share and lets either thread make it again on their shared branch", async () => {
    const parent = await prepared("Parent");
    const fork = forkOf(parent);
    await writeFile(path.join(parent.worktreePath!, "shared.ts"), "export const shared = true;\n");

    const result = await cleanup.remove([{ kind: "thread", id: parent.id }]);

    expect(result.failed).toEqual([]);
    expect(await gone(parent.worktreePath!)).toBe(true);
    expect(threads.get(db, parent.id)?.worktreePath).toBe(parent.worktreePath);
    expect(threads.get(db, fork.id)?.worktreePath).toBe(parent.worktreePath);
    const forkBack = await workspaces.prepareThread(threads.get(db, fork.id)!, project);
    expect(forkBack).toMatchObject({ worktreePath: parent.worktreePath, branch: parent.branch });
    expect(await readFile(path.join(parent.worktreePath!, "shared.ts"), "utf8")).toContain("shared = true");
    expect((await workspaces.prepareThread(threads.get(db, parent.id)!, project)).worktreePath).toBe(parent.worktreePath);
  });

  it("refuses a folder a legacy task shares with its thread", async () => {
    const thread = await prepared("Promoted");
    const task = tasks.insert(db, { projectId: project.id, title: "Legacy", spec: null, priority: "none", labels: [], workspaceMode: "worktree", baseRef: "main", parentTaskId: null });
    tasks.update(db, task.id, { worktreePath: thread.worktreePath, branch: thread.branch });

    const result = await cleanup.remove([{ kind: "task", id: task.id }]);

    expect(result.failed).toEqual([{ owner: { kind: "task", id: task.id }, message: expect.stringMatching(/Other saved work/) }]);
    expect(await gone(thread.worktreePath!)).toBe(false);
  });
});
