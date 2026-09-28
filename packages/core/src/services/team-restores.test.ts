import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Db, checkpoints, orchestration, projects, runs, teamContexts, teamRestores, teamRuntime, teamWorkspaces, threads } from "@openorc/db";
import { commitAll, git, teamTransfer } from "@openorc/git";
import { DEFAULT_TEAM_LIMITS, type Project, type TeamExecutionRecord, type Thread, type ThreadCheckpoint } from "@openorc/protocol";
import { TeamOperationGuard } from "./team-operations.js";
import { TeamRestoreService, type TeamRestoreHooks } from "./team-restores.js";
import { WorkspaceWriters } from "./workspace-writers.js";
import { buildTeamContextSeed, buildTeamForkSeed } from "./team-context.js";
import { teamWorkspaceLocation } from "./team-workspace-location.js";

let db: Db;
let folder: string;
let project: Project;
let thread: Thread;
let execution: TeamExecutionRecord;
let selected: ThreadCheckpoint;
let originalPath: string;
let writers: WorkspaceWriters;
let guard: TeamOperationGuard;
let service: TeamRestoreService;
let blocked: string | null;
const model = { agent: "codex" as const, model: "scripted-restore-fixture", effort: "high", fastMode: false };
const binary = Buffer.alloc(1_100_003, 0xa7);
const changed = vi.fn();
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function newService(hooks: TeamRestoreHooks = {}) {
  return new TeamRestoreService(db, path.join(folder, "data"), guard, writers, changed, hooks);
}
async function gitState(cwd: string) {
  const index = (await git(cwd, ["rev-parse", "--git-path", "index"])).stdout.trim();
  return { head: (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim(), index: await readFile(path.resolve(cwd, index)) };
}
function contextCount() {
  return teamContexts.listForInstance(db, execution.instanceId).length;
}
async function reopen() {
  db.close();
  db = Db.open(path.join(folder, "state.sqlite"));
  writers = new WorkspaceWriters();
  guard = new TeamOperationGuard(db, () => blocked, changed);
  service = newService();
}

beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "openorc-team-restores-"));
  const root = path.join(folder, "repository");
  originalPath = path.join(folder, "lead");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "README.md"), "Original committed files\n");
  await writeFile(path.join(root, ".gitignore"), ".env\ncarry.txt\n");
  const base = await commitAll(root, "Fixture baseline");
  await git(root, ["worktree", "add", "--detach", originalPath, base]);
  db = Db.open(path.join(folder, "state.sqlite"));
  project = projects.insert(db, { name: "Restore fixture", rootPath: root, defaultBranch: "main", gitRemote: null, settings: { worktreeInclude: [".env"] } });
  thread = threads.insert(db, { projectId: project.id, title: "Retained conversation", ...model, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
  thread = threads.update(db, thread.id, { worktreePath: originalPath, baseSha: base });
  const team = orchestration.save(db, {
    projectId: project.id,
    expectedRevisionId: null,
    draft: {
      name: "Restore team",
      limits: { ...DEFAULT_TEAM_LIMITS },
      discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
      members: [{ key: "lead", name: "Lead", managerKey: null, responsibility: "Coordinate", settings: model }],
    },
  });
  const instance = orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: team.revision.id });
  const now = Date.now();
  execution = teamRuntime.create(db, {
    id: randomUUID(),
    instanceId: instance.id,
    projectId: project.id,
    threadId: thread.id,
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
        input: { title: "Retained task", spec: "Preserve the original requirements", attachments: [], responsibility: "Coordinate", settings: model },
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
  const source = await teamTransfer.capture(root, { refPrefix: `refs/openorc/tests/${execution.id}/source` });
  const workspaceId = randomUUID();
  await writeFile(path.join(originalPath, "README.md"), "Selected checkpoint files\n");
  await writeFile(path.join(originalPath, "carry.txt"), "Inherited despite ignore rule\n");
  await writeFile(path.join(originalPath, "large.bin"), binary);
  await writeFile(path.join(originalPath, "tool.sh"), "#!/bin/sh\nexit 0\n");
  await chmod(path.join(originalPath, "tool.sh"), 0o755);
  await symlink("README.md", path.join(originalPath, "readme-link"));
  // This explicit input tree represents a path inherited before the ignore rule.
  const inherited = await teamTransfer.capture(originalPath, { refPrefix: `refs/openorc/tests/${execution.id}/inherited`, paths: ["carry.txt"] });
  const run = runs.insert(db, { id: randomUUID(), taskId: null, threadId: thread.id, ...model, mode: "act", permissionMode: "trusted" });
  const snapshot = await teamTransfer.capture(originalPath, { refPrefix: `refs/openorc/teams/${workspaceId}/checkpoints/${run.id}-${randomUUID()}`, trackedTree: inherited.treeSha });
  selected = checkpoints.insert(db, { threadId: thread.id, runId: run.id, turn: 1, treeSha: snapshot.treeSha, diffStat: { files: 5, insertions: 3, deletions: 1, untracked: 4 } });
  teamWorkspaces.save(db, {
    id: workspaceId,
    executionId: execution.id,
    actorId: "lead",
    taskId: null,
    parentActorId: null,
    path: originalPath,
    source,
    state: "ready",
    setupState: "completed",
    preparedTree: snapshot.treeSha,
    outputTree: snapshot.treeSha,
    error: null,
    createdAt: now,
    updatedAt: now,
  });
  const endedAt = Date.now();
  runs.update(db, run.id, { state: "success", endedAt, resultText: "Public result before later file edits" });
  execution = teamRuntime.update(db, execution.id, (current) => {
    current.attempts.push({
      id: randomUUID(),
      actorId: "lead",
      runId: run.id,
      generation: 1,
      state: "closed",
      mode: "act",
      resumeSessionId: null,
      settings: model,
      configurationVersion: 1,
      directionVersion: 0,
      messageIds: [],
      snapshotId: selected.id,
      error: null,
      createdAt: now,
      endedAt,
    });
    Object.assign(current.actors[0]!, { state: "completed", snapshotId: selected.id, result: "Public result before later file edits" });
    current.state = "completed";
  }).record;
  await writeFile(path.join(originalPath, "README.md"), "Later committed version\n");
  await writeFile(path.join(originalPath, "later.txt"), "Committed after the selected checkpoint\n");
  await commitAll(originalPath, "Later history must remain");
  await writeFile(path.join(originalPath, "README.md"), "Partially staged\n");
  await git(originalPath, ["add", "README.md"]);
  await writeFile(path.join(originalPath, "README.md"), "Current unstaged files\n");
  await writeFile(path.join(originalPath, ".env"), "LOCAL_VALUE=retained\n");
  thread = threads.update(db, thread.id, { branch: `openorc/team-${thread.id}` });
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

describe("retained team checkpoint restore", () => {
  it("cancels failed restore while preserving both workspaces and fencing delayed retries", async () => {
    service = newService({
      fault: (point) => {
        if (point === "materialized") throw new Error("Interrupted restore");
      },
    });
    const input = { threadId: thread.id, checkpointId: selected.id, requestKey: "cancel-restore" };
    await expect(service.restore(input)).rejects.toThrow("Interrupted restore");
    const receipt = teamRestores.find(db, thread.id, input.requestKey)!;
    const kept = path.join(receipt.paths[0]!, "manual.txt");
    await writeFile(kept, "Keep recovery work");
    expect(service.cancel(thread.id, input.requestKey)).toEqual({ state: "cancelled" });
    await reopen();
    expect(await readFile(kept, "utf8")).toBe("Keep recovery work");
    expect(threads.get(db, thread.id)?.worktreePath).toBe(originalPath);
    expect(contextCount()).toBe(0);
    expect(guard.reason(thread.id)).toBeNull();
    expect(await service.restore(input)).toMatchObject({ rejected: expect.stringMatching(/cancelled/) });
  });
  it("restores exact files in a new worktree while preserving HEAD, branch metadata, source bytes and partial staging", async () => {
    const before = await gitState(originalPath),
      initialExecution = teamRuntime.get(db, execution.id);
    await service.restore({ threadId: thread.id, checkpointId: selected.id, requestKey: "restore-files" });
    const current = threads.get(db, thread.id)!;
    expect(current.worktreePath).not.toBe(originalPath);
    expect(current).toMatchObject({ workspaceMode: "worktree", baseSha: before.head, branch: thread.branch });
    expect(await gitState(originalPath)).toEqual(before);
    expect(await readFile(path.join(originalPath, "README.md"), "utf8")).toBe("Current unstaged files\n");
    expect((await git(current.worktreePath!, ["rev-parse", "HEAD"])).stdout.trim()).toBe(before.head);
    expect((await git(current.worktreePath!, ["symbolic-ref", "-q", "HEAD"], { okCodes: [0, 1] })).code).toBe(1);
    expect(await readFile(path.join(current.worktreePath!, "README.md"), "utf8")).toBe("Selected checkpoint files\n");
    expect(await readFile(path.join(current.worktreePath!, "carry.txt"), "utf8")).toBe("Inherited despite ignore rule\n");
    expect(await readFile(path.join(current.worktreePath!, "large.bin"))).toEqual(binary);
    expect((await lstat(path.join(current.worktreePath!, "tool.sh"))).mode & 0o111).not.toBe(0);
    expect(await readlink(path.join(current.worktreePath!, "readme-link"))).toBe("README.md");
    await expect(readFile(path.join(current.worktreePath!, "later.txt"))).rejects.toThrow(/ENOENT/);
    expect(await readFile(path.join(current.worktreePath!, ".env"), "utf8")).toBe("LOCAL_VALUE=retained\n");
    const receipt = teamRestores.find(db, thread.id, "restore-files")!;
    expect(receipt).toMatchObject({ state: "applied", targetTree: selected.treeSha, appliedPath: current.worktreePath });
    const context = teamContexts.get(db, receipt.appliedContextId!)!;
    expect(context).toMatchObject({ instanceId: execution.instanceId, executionId: null, actorId: "lead", reason: "compact", requestKey: `restore:${receipt.id}` });
    expect(context.seed).toContain("Preserve the original requirements");
    expect(context.seed).toContain("explicitly restored");
    expect(teamWorkspaceLocation(db, thread.id)).toMatchObject({ path: current.worktreePath, trackedTree: selected.treeSha });
    const rebuilt = JSON.parse(buildTeamContextSeed(db, { instanceId: execution.instanceId, executionId: null, actorId: "lead" }));
    expect(rebuilt.restoredWorkspace).toMatchObject({ checkpointId: selected.id, treeSha: selected.treeSha, preservedHeadSha: before.head });
    expect(rebuilt.restoredWorkspace.note).toContain("Never replay historical assignments");
    expect(JSON.parse(buildTeamForkSeed(db, thread.id).seed).restoredWorkspace).toEqual(rebuilt.restoredWorkspace);
    expect(JSON.parse(buildTeamForkSeed(db, thread.id, selected.runId!).seed).restoredWorkspace).toBeUndefined();
    expect(teamRuntime.get(db, execution.id)).toEqual(initialExecution);
    expect(runs.listForThread(db, thread.id)).toHaveLength(1);
    expect(contextCount()).toBe(1);
  });

  it("coalesces identical requests and replays a lost applied response after restart without restoring later files again", async () => {
    const retained = deferred(),
      release = deferred();
    service = newService({
      fault: async (point) => {
        if (point === "retained") {
          retained.resolve();
          await release.promise;
        }
        if (point === "applied") throw new Error("Lost response after apply");
      },
    });
    const input = { threadId: thread.id, checkpointId: selected.id, requestKey: "replay" };
    const pending = service.restore(input);
    const rejected = expect(pending).rejects.toThrow(/Lost response/);
    expect(service.restore(input)).toBe(pending);
    await retained.promise;
    await expect(service.restore({ ...input, checkpointId: "changed" })).rejects.toThrow(/different work/);
    release.resolve();
    await rejected;
    const applied = threads.get(db, thread.id)!;
    await writeFile(path.join(applied.worktreePath!, "README.md"), "Work after accepted restore\n");
    const receipt = teamRestores.find(db, thread.id, "replay")!;
    await reopen();
    await service.restore(input);
    expect(threads.get(db, thread.id)?.worktreePath).toBe(applied.worktreePath);
    expect(await readFile(path.join(applied.worktreePath!, "README.md"), "utf8")).toBe("Work after accepted restore\n");
    expect(teamRestores.find(db, thread.id, "replay")).toEqual(receipt);
    expect(contextCount()).toBe(1);
  });

  it("keeps failed candidates and captured setup input while retrying in a new directory after restart", async () => {
    service = newService({
      fault: (point) => {
        if (point === "materialized") throw new Error("Interrupted before pointer update");
      },
    });
    const input = { threadId: thread.id, checkpointId: selected.id, requestKey: "recover" };
    await expect(service.restore(input)).rejects.toThrow(/Interrupted/);
    const first = teamRestores.find(db, thread.id, "recover")!;
    expect(first.state).toBe("attention");
    expect(threads.get(db, thread.id)?.worktreePath).toBe(originalPath);
    expect(contextCount()).toBe(0);
    await writeFile(path.join(first.paths[0]!, "manual-recovery.txt"), "Keep this failed candidate\n");
    await writeFile(path.join(originalPath, ".env"), "LOCAL_VALUE=edited-after-capture\n");
    expect(() => guard.assertAvailable(thread.id)).toThrow(/restore/);
    await reopen();
    expect(() => guard.assertAvailable(thread.id)).toThrow(/restore/);
    await service.restore(input);
    const applied = teamRestores.find(db, thread.id, "recover")!;
    expect(applied.paths).toHaveLength(2);
    expect(applied.appliedPath).not.toBe(first.paths[0]);
    expect(await readFile(path.join(first.paths[0]!, "manual-recovery.txt"), "utf8")).toBe("Keep this failed candidate\n");
    expect(await readFile(path.join(applied.appliedPath!, ".env"), "utf8")).toBe("LOCAL_VALUE=retained\n");
    expect(await readFile(path.join(originalPath, ".env"), "utf8")).toBe("LOCAL_VALUE=edited-after-capture\n");
    expect(() => guard.assertAvailable(thread.id)).not.toThrow();
  });

  it("blocks unsettled teams and existing writers before accepting restore side effects", async () => {
    const input = { threadId: thread.id, checkpointId: selected.id, requestKey: "blocked" };
    blocked = "A descendant still awaits approval.";
    await expect(service.restore(input)).resolves.toMatchObject({ rejected: expect.stringMatching(/awaits approval/) });
    expect(teamRestores.list(db)).toEqual([]);
    blocked = null;
    const writer = await writers.acquire(originalPath, "Existing provider writer");
    try {
      await expect(service.restore({ ...input, requestKey: "writer" })).resolves.toMatchObject({ rejected: expect.stringMatching(/Existing provider writer/) });
    } finally {
      writer.release();
    }
    expect(teamRestores.list(db)).toEqual([]);
    expect(contextCount()).toBe(0);
    await reopen();
    await expect(service.restore(input)).resolves.toMatchObject({ rejected: expect.stringMatching(/awaits approval/) });
    await expect(service.restore({ ...input, checkpointId: "different" })).rejects.toThrow(/different|identifies/);
    expect(teamRestores.find(db, thread.id, "blocked")).toBeNull();
    await service.restore({ ...input, requestKey: "unblocked" });
    expect(teamRestores.find(db, thread.id, "unblocked")?.state).toBe("applied");
  });

  it("rejects unknown or unverified historical checkpoints without recording a restore", async () => {
    await expect(service.restore({ threadId: thread.id, checkpointId: "unknown", requestKey: "unknown" })).resolves.toMatchObject({ rejected: expect.stringMatching(/checkpoint/) });
    const record = teamWorkspaces.get(db, execution.id, "lead")!;
    const prefix = `refs/openorc/teams/${record.id}/checkpoints/`;
    const refs = (await git(project.rootPath, ["for-each-ref", "--format=%(refname)", prefix])).stdout.trim().split("\n").filter(Boolean);
    for (const ref of refs) await git(project.rootPath, ["update-ref", "-d", ref]);
    await expect(service.restore({ threadId: thread.id, checkpointId: selected.id, requestKey: "legacy" })).resolves.toMatchObject({ rejected: expect.stringMatching(/verified exact/) });
    expect(teamRestores.list(db)).toEqual([]);
    expect(threads.get(db, thread.id)).toEqual(thread);
  });

  it("does not acknowledge a rejection whose durable receipt could not be stored", async () => {
    const reject = vi.spyOn(teamRestores, "reject").mockImplementation(() => {
      throw new Error("Cannot save rejection");
    });
    await expect(service.restore({ threadId: thread.id, checkpointId: "unknown", requestKey: "uncertain-rejection" })).rejects.toThrow(/Cannot save rejection/);
    expect(teamRestores.rejection(db, thread.id, "uncertain-rejection")).toBeNull();
    expect(contextCount()).toBe(0);
    reject.mockRestore();
    await expect(service.restore({ threadId: thread.id, checkpointId: "unknown", requestKey: "uncertain-rejection" })).resolves.toMatchObject({ rejected: expect.stringMatching(/checkpoint/) });
  });
});
