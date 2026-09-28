import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Db, audit, orchestration, projects, tasks, teamDeletedThreads, teamDeletions, teamRuntime, teamWorkspaces, threads } from "@openorc/db";
import { commitAll, git, teamTransfer } from "@openorc/git";
import { DEFAULT_TEAM_LIMITS, type Project, type TeamExecutionRecord, type Thread } from "@openorc/protocol";
import { TeamDeletionService, type TeamDeletionHooks } from "./team-deletions.js";
import { TeamOperationGuard } from "./team-operations.js";
import { WorkspaceWriters } from "./workspace-writers.js";
import { checkpointRefs } from "./checkpoint-refs.js";

let db: Db;
let folder: string;
let root: string;
let dataDir: string;
let project: Project;
let thread: Thread;
let execution: TeamExecutionRecord;
let workspace: string;
let writers: WorkspaceWriters;
let guard: TeamOperationGuard;
let service: TeamDeletionService;
let blocked: string | null;
const model = { agent: "codex" as const, model: "scripted-delete-fixture", effort: "high", fastMode: false };
const changed = vi.fn();
const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );
const newService = (hooks: TeamDeletionHooks = {}) => new TeamDeletionService(db, dataDir, guard, writers, changed, hooks);
async function reopen() {
  db.close();
  db = Db.open(path.join(folder, "state.sqlite"));
  writers = new WorkspaceWriters();
  guard = new TeamOperationGuard(db, () => blocked, changed);
  service = newService();
}
async function registered(cwd: string) {
  return (await git(cwd, ["worktree", "list", "--porcelain"])).stdout;
}

/** One completed lead execution whose worktree is a registered, detached linked worktree under the app data directory. */
async function leadWorkspace(record: TeamExecutionRecord, target: string, kind: "worktree" | "partial") {
  const head = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  const tree = (await git(root, ["rev-parse", "HEAD^{tree}"])).stdout.trim();
  if (kind === "worktree")
    await teamTransfer.materialize(root, {
      snapshot: { rootPath: root, headSha: head, treeSha: tree, branch: null, treeRef: "refs/heads/main", headRef: "refs/heads/main", indexSha256: null },
      path: target,
    });
  else {
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "partial.txt"), "Interrupted preparation\n");
  }
  const now = Date.now();
  teamWorkspaces.save(db, {
    id: randomUUID(),
    executionId: record.id,
    actorId: "lead",
    taskId: null,
    parentActorId: null,
    path: target,
    source: { rootPath: root, headSha: head, branch: "refs/heads/main", treeSha: tree, treeRef: "refs/heads/main", headRef: "refs/heads/main", indexSha256: null },
    state: kind === "worktree" ? "ready" : "attention",
    setupState: kind === "worktree" ? "completed" : "blocked",
    preparedTree: kind === "worktree" ? tree : null,
    outputTree: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  });
}
function completedExecution(threadId: string, instanceId: string): TeamExecutionRecord {
  const now = Date.now();
  const created = teamRuntime.create(db, {
    id: randomUUID(),
    instanceId,
    projectId: project.id,
    threadId,
    state: "active",
    generation: 1,
    revision: 0,
    limits: { ...DEFAULT_TEAM_LIMITS },
    actors: [
      {
        id: "lead",
        memberKey: "lead",
        parentId: null,
        taskId: null,
        requestKey: null,
        requestHash: null,
        dependencies: [],
        input: { title: "Exploration", spec: "Explore the code", attachments: [], responsibility: "Coordinate", settings: model },
        state: "queued",
        retries: 0,
        directionVersion: 0,
        deliveredVersion: 0,
        disposition: null,
        result: null,
        snapshotId: null,
        error: null,
      },
    ],
    attempts: [],
    messages: [],
    error: null,
    createdAt: now,
    updatedAt: now,
    deadlineAt: now + 3_600_000,
  });
  return teamRuntime.update(db, created.id, (current) => {
    current.state = "completed";
    current.actors[0]!.state = "completed";
    current.actors[0]!.result = "Explored";
  }).record;
}

beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "openorc-team-deletions-"));
  root = path.join(folder, "repository");
  dataDir = path.join(folder, "data");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "README.md"), "Committed files\n");
  await commitAll(root, "Fixture baseline");
  db = Db.open(path.join(folder, "state.sqlite"));
  project = projects.insert(db, { name: "Delete fixture", rootPath: root, defaultBranch: "main", gitRemote: null, settings: {} });
  thread = threads.insert(db, { projectId: project.id, title: "Throwaway team", ...model, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
  const team = orchestration.save(db, {
    projectId: project.id,
    expectedRevisionId: null,
    draft: {
      name: "Delete team",
      limits: { ...DEFAULT_TEAM_LIMITS },
      discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
      members: [{ key: "lead", name: "Lead", managerKey: null, responsibility: "Coordinate", settings: model }],
    },
  });
  const instance = orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: team.revision.id });
  execution = completedExecution(thread.id, instance.id);
  workspace = path.join(dataDir, "team-workspaces", execution.id, "lead");
  await leadWorkspace(execution, workspace, "worktree");
  thread = threads.update(db, thread.id, { worktreePath: workspace, baseSha: (await git(root, ["rev-parse", "HEAD"])).stdout.trim() });
  blocked = null;
  changed.mockClear();
  writers = new WorkspaceWriters();
  guard = new TeamOperationGuard(db, () => blocked, changed);
  service = newService();
});
afterEach(async () => {
  vi.restoreAllMocks();
  db?.close();
  if (folder) await rm(folder, { recursive: true, force: true });
});

describe("taskless team deletion cleanup", () => {
  it("cancels a delete before cleanup, retains the workspace and permits a fresh request", async () => {
    service = newService({
      fault: (point) => {
        if (point === "retained") throw new Error("Interrupted delete");
      },
    });
    const input = { threadId: thread.id, requestKey: "cancel-delete" };
    await expect(service.delete(input)).rejects.toThrow("Interrupted delete");
    expect(await service.cancel(thread.id, input.requestKey)).toEqual({ state: "cancelled" });
    await reopen();
    await service.recover();
    expect(await exists(workspace)).toBe(true);
    expect(guard.reason(thread.id)).toBeNull();
    expect(await service.delete(input)).toMatchObject({ rejected: expect.stringMatching(/cancelled/) });
    expect(await service.delete({ ...input, requestKey: "fresh-delete" })).toBeNull();
    expect(threads.get(db, thread.id)).toBeNull();
  });

  it("can finish interrupted deletion while retaining quarantined files and never removes them on replay", async () => {
    service = newService({
      cleanup: {
        fault: (point) => {
          if (point === "after-quarantine") throw new Error("Interrupted cleanup");
        },
      },
    });
    const input = { threadId: thread.id, requestKey: "keep-files" };
    await expect(service.delete(input)).rejects.toThrow("Interrupted cleanup");
    const receipt = teamDeletions.find(db, thread.id, input.requestKey)!;
    const kept = path.join(receipt.entries[0]!.quarantinePath, "manual.txt");
    await writeFile(kept, "Preserve remaining work");
    await expect(service.cancel(thread.id, input.requestKey)).rejects.toThrow(/already started/);
    expect(await service.cancel(thread.id, input.requestKey, true)).toEqual({ state: "applied" });
    await reopen();
    await service.recover();
    expect(await readFile(kept, "utf8")).toBe("Preserve remaining work");
    expect(threads.get(db, thread.id)).toBeNull();
    expect(await service.delete(input)).toBeNull();
    expect(await service.cancel(thread.id, input.requestKey, true)).toEqual({ state: "applied" });
    expect(await readFile(kept, "utf8")).toBe("Preserve remaining work");
  });

  it("quarantines before removing, survives an interruption and a recreated path, and finishes after restart", async () => {
    let interrupted = false;
    service = newService({
      cleanup: {
        fault: (point) => {
          if (point === "after-quarantine" && !interrupted) {
            interrupted = true;
            throw new Error("Power loss after quarantine");
          }
        },
      },
    });
    await expect(service.delete({ threadId: thread.id, requestKey: "delete" })).rejects.toThrow(/Power loss/);
    const receipt = teamDeletions.find(db, thread.id, "delete")!;
    expect(receipt).toMatchObject({ state: "attention", retainedTaskIds: [], items: [{ index: 0, state: "quarantined", updatedAt: expect.any(Number) }] });
    const entry = receipt.entries[0]!;
    expect(entry.registration).not.toBeNull();
    expect(await exists(entry.quarantinePath)).toBe(true);
    expect(await exists(workspace)).toBe(false);
    expect(threads.get(db, thread.id)).not.toBeNull();
    // Someone recreates the original path while the app is down. It is not ours to remove any more.
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "new-work.txt"), "Fresh unrelated files\n");
    await reopen();
    await service.recover();
    expect(teamDeletions.get(db, receipt.id)?.error).toMatch(/interrupted/);
    expect(() => guard.assertAvailable(thread.id)).toThrow(/retained deletion/);
    await expect(writers.acquire(entry.quarantinePath, "other writer")).rejects.toThrow(/in use/);
    expect(await service.delete({ threadId: thread.id, requestKey: "delete" })).toBeNull();
    expect(teamDeletions.get(db, receipt.id)).toMatchObject({ state: "applied", items: [{ index: 0, state: "removed", updatedAt: expect.any(Number) }] });
    expect(await exists(entry.quarantinePath)).toBe(false);
    expect(await exists(entry.registration!.gitDir)).toBe(false);
    expect(await readFile(path.join(workspace, "new-work.txt"), "utf8")).toBe("Fresh unrelated files\n");
    expect(await registered(root)).not.toContain(await realpath(workspace));
    expect(threads.get(db, thread.id)).toBeNull();
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("Committed files\n");
    expect(await service.delete({ threadId: thread.id, requestKey: "delete" })).toBeNull();
  });

  it("preserves a workspace replaced after inspection and keeps the conversation until the retry is inspected", async () => {
    service = newService({
      fault: async (point) => {
        if (point !== "retained") return;
        await rm(workspace, { recursive: true, force: true });
        await mkdir(workspace, { recursive: true });
        await writeFile(path.join(workspace, "replacement.txt"), "Not the captured directory\n");
      },
    });
    await expect(service.delete({ threadId: thread.id, requestKey: "delete" })).rejects.toThrow(/replaced/);
    expect(teamDeletions.find(db, thread.id, "delete")).toMatchObject({ state: "attention", error: expect.stringMatching(/replaced/) });
    expect(await readFile(path.join(workspace, "replacement.txt"), "utf8")).toBe("Not the captured directory\n");
    expect(threads.get(db, thread.id)).not.toBeNull();
    expect(service.availability(thread.id)).toEqual({ allowed: true, reason: null });
    expect(service.recovery(thread.id)).toMatchObject({ requestKey: "delete" });
  });

  it("removes only the exact retained registration when the workspace files already vanished", async () => {
    service = newService({
      fault: async (point) => {
        if (point === "retained") await rm(workspace, { recursive: true, force: true });
      },
    });
    const gitDir = (await git(workspace, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
    expect(await service.delete({ threadId: thread.id, requestKey: "delete" })).toBeNull();
    expect(await exists(gitDir)).toBe(false);
    expect(await registered(root)).not.toContain(execution.id);
    expect(threads.get(db, thread.id)).toBeNull();
    expect(teamDeletions.find(db, thread.id, "delete")).toMatchObject({ state: "applied" });
  });

  it("removes partial unregistered app-owned directories but never the checkout or a path another owner shares", async () => {
    const partial = completedExecution(thread.id, orchestration.getInstance(db, thread.id)!.id);
    const partialPath = path.join(dataDir, "team-workspaces", partial.id, "lead");
    await leadWorkspace(partial, partialPath, "partial");
    const shared = completedExecution(thread.id, orchestration.getInstance(db, thread.id)!.id);
    const sharedPath = path.join(dataDir, "team-workspaces", shared.id, "lead");
    await leadWorkspace(shared, sharedPath, "partial");
    threads.insert(db, { id: "neighbour", projectId: project.id, title: "Neighbour", ...model, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
    threads.update(db, "neighbour", { worktreePath: sharedPath });
    expect(await service.delete({ threadId: thread.id, requestKey: "delete" })).toBeNull();
    const receipt = teamDeletions.find(db, thread.id, "delete")!;
    expect(receipt.entries.map((entry) => entry.path).sort()).toEqual([workspace, partialPath].sort());
    expect(receipt.retainedPaths).toEqual([{ path: sharedPath, reason: expect.stringMatching(/shared with/) }]);
    expect(await exists(partialPath)).toBe(false);
    expect(await exists(workspace)).toBe(false);
    expect(await readFile(path.join(sharedPath, "partial.txt"), "utf8")).toBe("Interrupted preparation\n");
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("Committed files\n");
    expect(threads.get(db, "neighbour")?.worktreePath).toBe(sharedPath);
  });

  it("rejects durably before any receipt while the team is not quiescent or an operation is held", async () => {
    blocked = "Finish or stop the team's unfinished execution before this action.";
    expect(await service.delete({ threadId: thread.id, requestKey: "busy" })).toEqual({ rejected: blocked });
    expect(teamDeletions.find(db, thread.id, "busy")).toBeNull();
    expect(teamDeletions.rejection(db, thread.id, "busy")).toMatchObject({ error: blocked });
    blocked = null;
    expect(await service.delete({ threadId: thread.id, requestKey: "busy" })).toEqual({ rejected: expect.stringMatching(/unfinished execution/) });
    expect(await exists(workspace)).toBe(true);
    expect(service.availability(thread.id)).toEqual({ allowed: true, reason: null });
    const reservation = guard.reserve(thread.id);
    try {
      expect(await service.delete({ threadId: thread.id, requestKey: "held" })).toEqual({ rejected: expect.stringMatching(/workspace operation to finish/) });
    } finally {
      reservation.release();
    }
    expect(await exists(workspace)).toBe(true);
  });

  it("lets a hidden owner finish failed cleanup while keeping files and deleting its saved tasks", async () => {
    const task = tasks.insert(db, {
      projectId: project.id,
      threadId: thread.id,
      title: "Saved task",
      spec: "Keep the history",
      priority: "none",
      labels: [],
      workspaceMode: "worktree",
      baseRef: "main",
      parentTaskId: null,
      origin: "agent",
    });
    await service.delete({ threadId: thread.id, requestKey: "hide" });
    expect(teamDeletedThreads.has(db, thread.id)).toBe(true);
    service = newService({
      fault: (point) => {
        if (point === "retained") throw new Error("Cleanup interrupted");
      },
    });
    await expect(service.delete({ threadId: thread.id, requestKey: "final" })).rejects.toThrow("Cleanup interrupted");
    await expect(service.cancel(thread.id, "final", true)).resolves.toEqual({ state: "applied" });
    expect(threads.get(db, thread.id)).toBeNull();
    expect(tasks.get(db, task.id)).toBeNull();
    expect(await exists(workspace)).toBe(true);
    await reopen();
    await service.recover();
    expect(await exists(workspace)).toBe(true);
  });

  it("deletes a hidden owner's last saved tasks together: workspaces, owned refs, merged or pushed branches and exported patches go, unmerged work stays", async () => {
    const task = tasks.insert(db, {
      projectId: project.id,
      threadId: thread.id,
      title: "Saved follow-up",
      spec: "Finish",
      priority: "none",
      labels: [],
      workspaceMode: "worktree",
      baseRef: "main",
      parentTaskId: null,
      origin: "agent",
    });
    tasks.update(db, task.id, { worktreePath: workspace });
    const head = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
    const ordinary = `openorc/team-${thread.id}`,
      taskBranch = `openorc/team-task-${task.id}`;
    await git(root, ["branch", ordinary, head]);
    await git(root, ["branch", taskBranch, head]);
    await git(root, ["update-ref", `refs/openorc/teams/${teamWorkspaces.get(db, execution.id, "lead")!.id}/output-1/tree`, head]);
    await git(root, ["update-ref", "refs/openorc/teams/someone-else/tree", head]);
    // Unmerged, unpushed work on the task branch must survive; a pushed twin would not.
    const unmergedTree = (await git(root, ["commit-tree", `${head}^{tree}`, "-p", head, "-m", "Unpublished assignment work"])).stdout.trim();
    await git(root, ["update-ref", `refs/heads/${taskBranch}`, unmergedTree]);
    await mkdir(path.join(dataDir, "exports"), { recursive: true });
    const patch = path.join(dataDir, "exports", `saved-follow-up-${task.id.slice(0, 8)}-1.patch`),
      foreign = path.join(folder, "elsewhere.patch");
    await writeFile(patch, "diff\n");
    await writeFile(foreign, "diff\n");
    audit.record(db, { actor: "user", action: "review.export", resourceType: "task", resourceId: task.id, metadata: { path: patch } });
    audit.record(db, { actor: "user", action: "review.export", resourceType: "task", resourceId: task.id, metadata: { path: foreign } });

    expect(service.ownerDeletion(thread.id)).toBeUndefined();
    expect(await service.delete({ threadId: thread.id, requestKey: "hide" })).toBeNull();
    expect(teamDeletedThreads.has(db, thread.id)).toBe(true);
    expect(service.ownerDeletion(thread.id)).toEqual({ allowed: true, reason: null, taskIds: [task.id] });
    expect(await service.delete({ threadId: thread.id, requestKey: "final" })).toBeNull();
    const receipt = teamDeletions.find(db, thread.id, "final")!;
    expect(receipt).toMatchObject({ state: "applied", retainedTaskIds: [], deletedTaskIds: [task.id], exports: [patch], appliedContextId: null });
    expect(receipt.entries.map((entry) => entry.path)).toEqual([workspace]);
    expect(receipt.git.branches.map((branch) => branch.name).sort()).toEqual([ordinary, taskBranch].sort());
    expect(receipt.git.refPrefixes).toEqual([checkpointRefs(thread.id), expect.stringMatching(/^refs\/openorc\/teams\/[^/]+\/$/)]);
    expect(threads.get(db, thread.id)).toBeNull();
    expect(tasks.get(db, task.id)).toBeNull();
    expect(orchestration.getInstance(db, thread.id)).toBeNull();
    expect(teamDeletedThreads.has(db, thread.id)).toBe(true);
    expect(await exists(workspace)).toBe(false);
    expect(await exists(patch)).toBe(false);
    expect(await exists(foreign)).toBe(true);
    expect((await git(root, ["for-each-ref", "--format=%(refname)", "refs/openorc/"])).stdout.trim()).toBe("refs/openorc/teams/someone-else/tree");
    expect((await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${ordinary}`], { okCodes: [0, 1] })).code).toBe(1);
    expect((await git(root, ["rev-parse", `refs/heads/${taskBranch}`])).stdout.trim()).toBe(unmergedTree);
    const audited = db.stmt("SELECT metadata FROM audit_events WHERE action='team.delete' ORDER BY id DESC LIMIT 1").get() as { metadata: string };
    expect(JSON.parse(audited.metadata)).toMatchObject({
      deletedTaskIds: [task.id],
      deletedBranches: [ordinary],
      retainedBranches: [{ name: taskBranch, reason: expect.stringMatching(/neither merged into main nor pushed/) }],
      deletedRefs: 1,
      removedExports: [patch],
    });
    expect(await service.delete({ threadId: thread.id, requestKey: "final" })).toBeNull();
    expect(await registered(root)).not.toContain(workspace);
  });
});
