import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db, checkpoints, orchestration, projects, runs, teamContexts, teamMoves, teamRestores, teamRuntime, teamWorkspaces, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { DEFAULT_TEAM_LIMITS, type Project, type TeamExecutionRecord, type Thread, type ThreadCheckpoint, type WorkspaceMode } from "@openorc/protocol";
import { buildTeamContextSeed } from "./team-context.js";
import { TeamForkService } from "./team-forks.js";
import { TeamMoveService, type TeamMoveHooks } from "./team-moves.js";
import { TeamOperationGuard } from "./team-operations.js";
import { TeamRestoreService } from "./team-restores.js";
import { teamPublicationBranch, teamWorkspaceLocation } from "./team-workspace-location.js";
import { TeamWorkspaceService } from "./team-workspaces.js";
import { WorkspaceWriters } from "./workspace-writers.js";

let db: Db, folder: string, root: string, originalPath: string;
let project: Project, thread: Thread, execution: TeamExecutionRecord, selected: ThreadCheckpoint;
let writers: WorkspaceWriters, guard: TeamOperationGuard, service: TeamMoveService, workspaces: TeamWorkspaceService;
let blocked: string | null, fault: NonNullable<TeamMoveHooks["fault"]>;
const settings = { agent: "codex" as const, model: "scripted-fixture", effort: "high", fastMode: false };
const binary = Buffer.from([0, 255, 0, 126, 10, 0, 128]);
const active = () => {};
const current = () => threads.get(db, thread.id)!;
const contexts = () => teamContexts.listForInstance(db, execution.instanceId);
function construct() {
  writers = new WorkspaceWriters();
  guard = new TeamOperationGuard(db, (id) => blocked ?? (teamRuntime.activeForThread(db, id) ? "An execution is still active" : null), active);
  service = new TeamMoveService(db, path.join(folder, "data"), guard, writers, active, { fault: (...args) => fault(...args) });
  workspaces = new TeamWorkspaceService(db, { dataDir: path.join(folder, "data") }, writers);
}
function beginExecution() {
  const now = Date.now();
  const instance = orchestration.getInstance(db, thread.id)!;
  execution = teamRuntime.create(db, {
    id: randomUUID(),
    instanceId: instance.id,
    threadId: thread.id,
    projectId: project.id,
    state: "active",
    generation: 1,
    revision: 0,
    limits: DEFAULT_TEAM_LIMITS,
    actors: [
      {
        id: "lead",
        memberKey: "lead",
        taskId: null,
        parentId: null,
        requestKey: null,
        requestHash: null,
        dependencies: [],
        input: { title: "Implement", spec: "Keep all original requirements", responsibility: "Coordinate", settings, attachments: [] },
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
  const context = teamContexts.latest(db, { instanceId: instance.id, executionId: null, actorId: "lead" });
  teamRuntime.update(db, execution.id, (record) => {
    record.attempts.push({
      id: randomUUID(),
      actorId: "lead",
      runId: null,
      generation: record.generation,
      state: "starting",
      settings,
      configurationVersion: instance.configurationVersion,
      directionVersion: 0,
      messageIds: [],
      snapshotId: null,
      error: null,
      createdAt: now,
      endedAt: null,
      ...(context ? { contextCheckpointId: context.id, contextSeed: buildTeamContextSeed(db, { instanceId: instance.id, executionId: null, actorId: "lead" }) } : { resumeSessionId: null }),
    });
  });
}
async function completeExecution(change: (cwd: string) => Promise<void>) {
  await workspaces.prepare(execution.id, "lead", active);
  const workspace = teamWorkspaces.get(db, execution.id, "lead")!;
  const run = runs.insert(db, { id: randomUUID(), threadId: thread.id, taskId: null, ...settings, mode: "act", permissionMode: "review" });
  teamRuntime.update(db, execution.id, (record) => {
    const attempt = record.attempts.at(-1)!;
    attempt.runId = run.id;
    attempt.state = "running";
    record.actors[0]!.state = "running";
  });
  await change(workspace.path);
  const lease = await writers.acquire(workspace.path, "capture scripted completed turn");
  let tree: string | null;
  try {
    tree = await workspaces.captureRunCheckpoint(run.id, workspace.path, lease);
  } finally {
    lease.release();
  }
  if (!tree) throw new Error("No exact team checkpoint");
  const checkpoint = checkpoints.insert(db, { threadId: thread.id, runId: run.id, turn: 1, treeSha: tree, diffStat: { files: 1, insertions: 1, deletions: 0, untracked: 0 } });
  await workspaces.captureOutput(execution.id, "lead", active);
  runs.update(db, run.id, { state: "success", endedAt: Date.now(), resultText: "Completed requested change" });
  teamRuntime.update(db, execution.id, (record) => {
    const attempt = record.attempts.at(-1)!;
    attempt.state = "closed";
    attempt.snapshotId = checkpoint.id;
    attempt.endedAt = Date.now();
    record.state = "completed";
    record.actors[0]!.state = "completed";
    record.actors[0]!.snapshotId = checkpoint.id;
    record.actors[0]!.result = "Completed requested change";
  });
  return checkpoint;
}
async function move(to: WorkspaceMode, requestKey: string) {
  const result = await service.move({ threadId: thread.id, to, requestKey });
  if ("rejected" in result) throw new Error(result.rejected);
  return result;
}
async function gitState(cwd = root) {
  const index = (await git(cwd, ["rev-parse", "--git-path", "index"])).stdout.trim();
  return {
    head: (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim(),
    branch: (await git(cwd, ["symbolic-ref", "-q", "HEAD"], { okCodes: [0, 1] })).stdout.trim(),
    index: await readFile(path.resolve(cwd, index)),
  };
}
async function reopen() {
  await service.shutdown();
  await workspaces.shutdown();
  await guard.shutdown();
  db.close();
  db = Db.open(path.join(folder, "fixture.sqlite"));
  fault = async () => {};
  construct();
  await workspaces.recover();
  await service.recover();
}
beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "openorc-move-"));
  root = path.join(folder, "repository");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await writeFile(path.join(root, "README.md"), "Base documentation\n");
  await writeFile(path.join(root, "user.txt"), "Original user file\n");
  await writeFile(path.join(root, ".gitignore"), ".env\n");
  await commitAll(root, "Baseline");
  await writeFile(path.join(root, "user.txt"), "Staged user file\n");
  await git(root, ["add", "user.txt"]);
  await writeFile(path.join(root, "user.txt"), "Unstaged user file\n");
  await writeFile(path.join(root, "carry.txt"), "Inherited input\n");
  await writeFile(path.join(root, ".env"), "LOCAL_SETUP=original\n");
  db = Db.open(path.join(folder, "fixture.sqlite"));
  project = projects.insert(db, { name: "Move fixture", rootPath: root, defaultBranch: "main", gitRemote: null, settings: { worktreeInclude: [".env"] } });
  thread = threads.insert(db, { projectId: project.id, title: "Move team", ...settings, mode: "act", permissionMode: "review", workspaceMode: "worktree" });
  const saved = orchestration.save(db, {
    projectId: project.id,
    expectedRevisionId: null,
    draft: {
      name: "Move",
      limits: DEFAULT_TEAM_LIMITS,
      discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
      members: [{ key: "lead", name: "Lead", managerKey: null, responsibility: "Coordinate", settings }],
    },
  });
  orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: saved.revision.id });
  blocked = null;
  fault = async () => {};
  construct();
  beginExecution();
  selected = await completeExecution(async (cwd) => {
    originalPath = cwd;
    await writeFile(path.join(cwd, "a-team.txt"), "Original team result\n");
  });
});
afterEach(async () => {
  await service?.shutdown();
  await workspaces?.shutdown();
  await guard?.shutdown();
  db?.close();
  if (folder) await rm(folder, { recursive: true, force: true });
});

describe("durable movement between an integrated team and the local checkout", () => {
  it("moves a team started locally out and back while preserving pre-existing and between-turn checkout edits", async () => {
    const revision = orchestration.getInstance(db, thread.id)!.teamRevisionId;
    thread = threads.insert(db, { projectId: project.id, title: "Local from birth", ...settings, mode: "act", permissionMode: "review", workspaceMode: "current" });
    orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: revision });
    const before = await gitState();
    beginExecution();
    const checkpoint = await completeExecution(async (cwd) => {
      expect(cwd).toBe(root);
      await writeFile(path.join(cwd, "local-team.txt"), "First local result\n");
    });
    expect(checkpoint.treeSha).toBeTruthy();
    await writeFile(path.join(root, "between-turns.txt"), "User work between turns\n");
    beginExecution();
    await completeExecution(async (cwd) => {
      await writeFile(path.join(cwd, "local-team.txt"), "Second local result\n");
    });
    await reopen();
    expect(teamWorkspaceLocation(db, thread.id).path).toBe(root);
    expect(service.availability(thread.id)).toEqual({ allowed: true, reason: null });
    const isolated = await move("worktree", "first-local-out");
    expect(isolated.worktreePath).toBeTruthy();
    expect(await readFile(path.join(isolated.worktreePath!, "local-team.txt"), "utf8")).toBe("Second local result\n");
    await expect(lstat(path.join(root, "local-team.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(root, "between-turns.txt"), "utf8")).toBe("User work between turns\n");
    expect(await readFile(path.join(root, "carry.txt"), "utf8")).toBe("Inherited input\n");
    expect(await readFile(path.join(root, "user.txt"), "utf8")).toBe("Unstaged user file\n");
    expect(await gitState()).toEqual(before);
    beginExecution();
    await completeExecution(async (cwd) => {
      expect(cwd).not.toBe(root);
      expect(await readFile(path.join(cwd, "local-team.txt"), "utf8")).toBe("Second local result\n");
    });
    await move("current", "first-local-return");
    expect(await readFile(path.join(root, "local-team.txt"), "utf8")).toBe("Second local result\n");
    expect(await gitState()).toEqual(before);
    beginExecution();
    await completeExecution(async (cwd) => {
      expect(cwd).toBe(root);
    });
    expect(teamWorkspaceLocation(db, thread.id).path).toBe(root);
  });

  it("keeps the original inherited baseline across multiple isolated lead executions", async () => {
    beginExecution();
    await completeExecution(async (cwd) => {
      await writeFile(path.join(cwd, "carry.txt"), "First change to inherited input\n");
    });
    beginExecution();
    await completeExecution(async (cwd) => {
      await writeFile(path.join(cwd, "carry.txt"), "Second change to inherited input\n");
      await writeFile(path.join(cwd, "user.txt"), "Team changed the inherited unstaged input\n");
    });
    const before = await gitState();
    await move("current", "inherited-multiple-executions");
    expect(await readFile(path.join(root, "carry.txt"), "utf8")).toBe("Second change to inherited input\n");
    expect(await readFile(path.join(root, "user.txt"), "utf8")).toBe("Team changed the inherited unstaged input\n");
    expect(await readFile(path.join(root, "a-team.txt"), "utf8")).toBe("Original team result\n");
    expect(await gitState()).toEqual(before);
  });

  it("preserves inherited checkout lineage through a restore of an isolated lead checkpoint", async () => {
    beginExecution();
    const target = await completeExecution(async (cwd) => {
      await writeFile(path.join(cwd, "carry.txt"), "Selected checkpoint input\n");
    });
    beginExecution();
    await completeExecution(async (cwd) => {
      await writeFile(path.join(cwd, "carry.txt"), "Later input excluded by restore\n");
    });
    const before = await gitState();
    const restore = new TeamRestoreService(db, path.join(folder, "data"), guard, writers, active);
    try {
      expect(await restore.restore({ threadId: thread.id, checkpointId: target.id, requestKey: "restore-inherited-input" })).toBeNull();
      await move("current", "restored-inherited-input");
      expect(await readFile(path.join(root, "carry.txt"), "utf8")).toBe("Selected checkpoint input\n");
      expect(await readFile(path.join(root, "a-team.txt"), "utf8")).toBe("Original team result\n");
      expect(await gitState()).toEqual(before);
    } finally {
      await restore.shutdown();
    }
  });

  it("uses the cleaned checkout baseline when moving inherited edits back to local a second time", async () => {
    await writeFile(path.join(originalPath, "carry.txt"), "First published inherited edit\n");
    const before = await gitState();
    await move("current", "inherited-first-local");
    const isolated = await move("worktree", "inherited-back-to-worktree");
    expect(await readFile(path.join(root, "carry.txt"), "utf8")).toBe("Inherited input\n");
    expect(await readFile(path.join(isolated.worktreePath!, "carry.txt"), "utf8")).toBe("First published inherited edit\n");
    await writeFile(path.join(root, "unrelated.txt"), "User work after move cleanup\n");
    beginExecution();
    await completeExecution(async (cwd) => {
      await writeFile(path.join(cwd, "carry.txt"), "Second published inherited edit\n");
    });
    await move("current", "inherited-second-local");
    expect(await readFile(path.join(root, "carry.txt"), "utf8")).toBe("Second published inherited edit\n");
    expect(await readFile(path.join(root, "a-team.txt"), "utf8")).toBe("Original team result\n");
    expect(await readFile(path.join(root, "unrelated.txt"), "utf8")).toBe("User work after move cleanup\n");
    expect(await gitState()).toEqual(before);
  });

  it("moves a historical local fork using the selected lead input rather than treating its output as unchanged baseline", async () => {
    await move("current", "local-before-cutoff");
    beginExecution();
    const cutoff = await completeExecution(async (cwd) => {
      await writeFile(path.join(cwd, "carry.txt"), "Historical local result\n");
    });
    beginExecution();
    await completeExecution(async (cwd) => {
      await writeFile(path.join(cwd, "carry.txt"), "Later local result\n");
      await writeFile(path.join(cwd, "after-cutoff.txt"), "Later output must remain outside the fork\n");
    });
    const forks = new TeamForkService(db, path.join(folder, "data"), guard, writers, active);
    try {
      const fork = await forks.fork({ threadId: thread.id, upToRunId: cutoff.runId!, requestKey: "fork-local-cutoff" });
      if ("rejected" in fork) throw new Error(fork.rejected);
      await move("worktree", "remove-original-local-results");
      expect(await readFile(path.join(root, "carry.txt"), "utf8")).toBe("Inherited input\n");
      await expect(lstat(path.join(root, "a-team.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(path.join(root, "after-cutoff.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      const before = await gitState();
      thread = fork;
      await move("current", "publish-local-cutoff-fork");
      expect(await readFile(path.join(root, "carry.txt"), "utf8")).toBe("Historical local result\n");
      expect(await readFile(path.join(root, "a-team.txt"), "utf8")).toBe("Original team result\n");
      await expect(lstat(path.join(root, "after-cutoff.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await gitState()).toEqual(before);
    } finally {
      await forks.shutdown();
    }
  });

  it("round-trips binary, symlink, executable and nowignored input while preserving unrelated checkout files and the exact index", async () => {
    await writeFile(path.join(originalPath, "large.bin"), binary);
    await writeFile(path.join(originalPath, "tool.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(originalPath, "tool.sh"), 0o755);
    await symlink("a-team.txt", path.join(originalPath, "team-link"));
    await writeFile(path.join(originalPath, ".gitignore"), ".env\ncarry.txt\n");
    const before = await gitState(),
      original = await gitState(originalPath);
    const local = await move("current", "local-files");
    expect(local).toMatchObject({ workspaceMode: "current", worktreePath: null });
    expect(await readFile(path.join(root, "large.bin"))).toEqual(binary);
    expect(await readlink(path.join(root, "team-link"))).toBe("a-team.txt");
    expect(await gitState()).toEqual(before);
    expect(await readFile(path.join(root, ".env"), "utf8")).toBe("LOCAL_SETUP=original\n");
    await writeFile(path.join(root, "unrelated.txt"), "External local work\n");
    const back = await move("worktree", "isolated-files");
    expect(back.worktreePath).not.toBe(originalPath);
    const cwd = back.worktreePath!;
    expect(await readFile(path.join(cwd, "large.bin"))).toEqual(binary);
    expect(await readlink(path.join(cwd, "team-link"))).toBe("a-team.txt");
    expect((await lstat(path.join(cwd, "tool.sh"))).mode & 0o111).not.toBe(0);
    expect(await readFile(path.join(cwd, "carry.txt"), "utf8")).toBe("Inherited input\n");
    expect(await readFile(path.join(cwd, ".env"), "utf8")).toBe("LOCAL_SETUP=original\n");
    expect(await readFile(path.join(root, "unrelated.txt"), "utf8")).toBe("External local work\n");
    expect(await readFile(path.join(root, "carry.txt"), "utf8")).toBe("Inherited input\n");
    await expect(lstat(path.join(root, "a-team.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(root, "large.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await gitState()).toEqual(before);
    expect(await gitState(originalPath)).toEqual(original);
    expect(teamWorkspaceLocation(db, thread.id).path).toBe(cwd);
    expect(teamPublicationBranch(db, thread.id)).toBe(back.branch);
    expect((await git(root, ["show-ref", "--verify", "--quiet", "refs/heads/" + back.branch], { okCodes: [0, 1] })).code).toBe(1);
    expect(contexts()).toHaveLength(2);
  });

  it("reverses multiple local lead outputs newest first while preserving unrelated user edits", async () => {
    await move("current", "local");
    const before = await gitState();
    beginExecution();
    await completeExecution(async (cwd) => {
      expect(cwd).toBe(root);
      await writeFile(path.join(cwd, "a-team.txt"), "First local result\n");
    });
    await writeFile(path.join(root, "unrelated.txt"), "Outside the team\n");
    beginExecution();
    await completeExecution(async (cwd) => {
      expect(cwd).toBe(root);
      await writeFile(path.join(cwd, "a-team.txt"), "Second local result\n");
      await writeFile(path.join(cwd, "local-child.txt"), "Another accepted result\n");
    });
    const back = await move("worktree", "back");
    expect(await readFile(path.join(back.worktreePath!, "a-team.txt"), "utf8")).toBe("Second local result\n");
    expect(await readFile(path.join(back.worktreePath!, "local-child.txt"), "utf8")).toBe("Another accepted result\n");
    await expect(lstat(path.join(root, "a-team.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(root, "local-child.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(root, "unrelated.txt"), "utf8")).toBe("Outside the team\n");
    expect(await gitState()).toEqual(before);
    expect(teamMoves.find(db, thread.id, "back")?.deltas).toHaveLength(3);
  });

  it("keeps committed local history when returning later uncommitted team work to a worktree", async () => {
    await move("current", "local");
    beginExecution();
    await completeExecution(async (cwd) => {
      await writeFile(path.join(cwd, "a-team.txt"), "Committed team result\n");
    });
    const committed = await commitAll(root, "User accepted local work");
    beginExecution();
    await completeExecution(async (cwd) => {
      await writeFile(path.join(cwd, "a-team.txt"), "Later uncommitted team result\n");
      await writeFile(path.join(cwd, "uncommitted.txt"), "Uncommitted team file\n");
    });
    const before = await gitState();
    const back = await move("worktree", "back-after-commit");
    expect(await gitState()).toEqual(before);
    expect(before.head).toBe(committed);
    expect(await readFile(path.join(root, "a-team.txt"), "utf8")).toBe("Committed team result\n");
    await expect(lstat(path.join(root, "uncommitted.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(back.worktreePath!, "a-team.txt"), "utf8")).toBe("Later uncommitted team result\n");
    expect((await git(back.worktreePath!, ["rev-parse", "HEAD"])).stdout.trim()).toBe(committed);
    expect(teamMoves.find(db, thread.id, "back-after-commit")?.deltas).toHaveLength(4);
  });

  it("replays a lost applied response after reopen without applying again or replacing later user changes", async () => {
    fault = async (point) => {
      if (point === "applied") throw new Error("Response lost after apply");
    };
    await expect(move("current", "lost")).rejects.toThrow(/Response lost/);
    const receipt = teamMoves.find(db, thread.id, "lost")!;
    expect(receipt.state).toBe("applied");
    await writeFile(path.join(root, "a-team.txt"), "User changed accepted output\n");
    await reopen();
    const replay = await move("current", "lost");
    expect(replay.workspaceMode).toBe("current");
    expect(await readFile(path.join(root, "a-team.txt"), "utf8")).toBe("User changed accepted output\n");
    expect(teamMoves.find(db, thread.id, "lost")).toEqual(receipt);
    expect(contexts()).toHaveLength(1);
    await expect(service.move({ threadId: thread.id, to: "worktree", requestKey: "lost" })).rejects.toThrow(/different work/);
    expect(await service.cancel(thread.id, "lost")).toEqual({ state: "applied" });
  });

  it("restores writer fences after an interrupted publication and resumes exactly once", async () => {
    await writeFile(path.join(originalPath, "b-team.txt"), "Second team result\n");
    const before = await gitState();
    let failed = false;
    fault = async (point) => {
      if (point === "after-write" && !failed) {
        failed = true;
        throw new Error("Injected partial publication");
      }
    };
    await expect(move("current", "partial")).rejects.toThrow(/partial publication/);
    const receipt = teamMoves.find(db, thread.id, "partial")!;
    expect(receipt).toMatchObject({ state: "attention", publication: expect.any(Object) });
    expect(current().worktreePath).toBe(originalPath);
    await expect(writers.acquire(root, "other checkout writer")).rejects.toThrow(/in use/);
    await reopen();
    await expect(writers.acquire(root, "other checkout writer")).rejects.toThrow(/Recover team move/);
    await expect(writers.acquire(originalPath, "other source writer")).rejects.toThrow(/Recover team move/);
    await move("current", "partial");
    expect(await readFile(path.join(root, "a-team.txt"), "utf8")).toBe("Original team result\n");
    expect(await readFile(path.join(root, "b-team.txt"), "utf8")).toBe("Second team result\n");
    expect(await gitState()).toEqual(before);
    expect(contexts()).toHaveLength(1);
    const lease = await writers.acquire(root, "released writer");
    lease.release();
  });

  it("cancels a partially published move by reversing only its files and preserving unrelated external edits", async () => {
    await writeFile(path.join(originalPath, "b-team.txt"), "Second team result\n");
    const before = await gitState();
    fault = async (point) => {
      if (point === "after-write") throw new Error("Stop after first write");
    };
    await expect(move("current", "cancel")).rejects.toThrow(/Stop after first write/);
    await writeFile(path.join(root, "external.txt"), "External edits survive cancellation\n");
    await reopen();
    expect(await service.cancel(thread.id, "cancel")).toEqual({ state: "cancelled" });
    expect(current().worktreePath).toBe(originalPath);
    expect(await readFile(path.join(root, "external.txt"), "utf8")).toBe("External edits survive cancellation\n");
    await expect(lstat(path.join(root, "a-team.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(root, "b-team.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await gitState()).toEqual(before);
    expect(contexts()).toHaveLength(0);
    expect(await service.cancel(thread.id, "cancel")).toEqual({ state: "cancelled" });
    expect(await service.move({ threadId: thread.id, to: "current", requestKey: "cancel" })).toMatchObject({ rejected: expect.stringContaining("cancelled") });
  });

  it("retains an interrupted return candidate and materializes a new exact copy before resuming checkout cleanup", async () => {
    await writeFile(path.join(originalPath, "b-team.txt"), "Second team result\n");
    await move("current", "local-before-return");
    const before = await gitState();
    let failed = false;
    fault = async (point) => {
      if (point === "after-write" && !failed) {
        failed = true;
        throw new Error("Interrupted checkout cleanup");
      }
    };
    await expect(move("worktree", "return")).rejects.toThrow(/Interrupted checkout cleanup/);
    const pending = teamMoves.find(db, thread.id, "return")!;
    const oldCandidate = pending.paths.find((item) => item.kind === "workspace")!.path;
    expect(await readFile(path.join(oldCandidate, "a-team.txt"), "utf8")).toBe("Original team result\n");
    expect(current().workspaceMode).toBe("current");
    await reopen();
    const completed = await move("worktree", "return");
    expect(completed.worktreePath).not.toBe(oldCandidate);
    expect(teamMoves.find(db, thread.id, "return")?.paths.filter((item) => item.kind === "workspace")).toHaveLength(2);
    expect(await readFile(path.join(oldCandidate, "a-team.txt"), "utf8")).toBe("Original team result\n");
    expect(await readFile(path.join(completed.worktreePath!, "a-team.txt"), "utf8")).toBe("Original team result\n");
    expect(await readFile(path.join(completed.worktreePath!, "b-team.txt"), "utf8")).toBe("Second team result\n");
    await expect(lstat(path.join(root, "a-team.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(root, "b-team.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await gitState()).toEqual(before);
    expect(contexts()).toHaveLength(2);
  });

  it("refuses cancellation over changed publication bytes until the user reconciles them", async () => {
    fault = async (point) => {
      if (point === "after-write") throw new Error("Interrupted");
    };
    await expect(move("current", "drift")).rejects.toThrow(/Interrupted/);
    await writeFile(path.join(root, "a-team.txt"), "An external editor owns this text\n");
    await expect(service.cancel(thread.id, "drift")).rejects.toThrow(/External changes/);
    expect(await readFile(path.join(root, "a-team.txt"), "utf8")).toBe("An external editor owns this text\n");
    expect(teamMoves.find(db, thread.id, "drift")).toMatchObject({ state: "attention", cancelRequested: true });
    await expect(writers.acquire(root, "still fenced")).rejects.toThrow(/in use/);
    await writeFile(path.join(root, "a-team.txt"), "Original team result\n");
    expect(await service.cancel(thread.id, "drift")).toEqual({ state: "cancelled" });
    await expect(lstat(path.join(root, "a-team.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps conflicts in scratch storage and permits cancellation without touching either source", async () => {
    await writeFile(path.join(originalPath, "README.md"), "Team changed the same line\n");
    await writeFile(path.join(root, "README.md"), "User changed the same line\n");
    const before = await gitState();
    await expect(move("current", "conflict")).rejects.toThrow(/conflicts/);
    const receipt = teamMoves.find(db, thread.id, "conflict")!;
    expect(receipt).toMatchObject({ state: "attention", publication: null });
    expect(receipt.paths.some((item) => item.kind === "scratch")).toBe(true);
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("User changed the same line\n");
    expect(await service.cancel(thread.id, "conflict")).toEqual({ state: "cancelled" });
    expect(await gitState()).toEqual(before);
    expect(await readFile(path.join(originalPath, "README.md"), "utf8")).toBe("Team changed the same line\n");
  });

  it("distinguishes permanent pre-admission rejection from a retained uncertain move", async () => {
    blocked = "A provider is still closing";
    const input = { threadId: thread.id, to: "current" as const, requestKey: "rejected" };
    expect(await service.move(input)).toEqual({ rejected: blocked });
    expect(teamMoves.find(db, thread.id, input.requestKey)).toBeNull();
    blocked = null;
    expect(await service.move(input)).toEqual({ rejected: "A provider is still closing" });
    fault = async (point) => {
      if (point === "retained") throw new Error("Uncertain accepted work");
    };
    await expect(move("current", "accepted")).rejects.toThrow(/Uncertain accepted/);
    expect(teamMoves.find(db, thread.id, "accepted")?.state).toBe("attention");
    expect(teamMoves.rejection(db, thread.id, "accepted")).toBeNull();
    fault = async () => {};
    expect((await move("current", "accepted")).workspaceMode).toBe("current");
  });

  it("authorizes only the retained local-source restore branch and keeps it through a later isolated restore", async () => {
    await move("current", "local-restore");
    const restore = new TeamRestoreService(db, path.join(folder, "data"), guard, writers, active);
    try {
      await restore.restore({ threadId: thread.id, checkpointId: selected.id, requestKey: "restore-from-local" });
      const receipt = teamRestores.find(db, thread.id, "restore-from-local")!;
      const branch = "openorc/team-" + thread.id + "-restore-" + receipt.id;
      expect(current().branch).toBe(branch);
      expect(teamPublicationBranch(db, thread.id)).toBe(branch);
      await restore.restore({ threadId: thread.id, checkpointId: selected.id, requestKey: "restore-from-isolated" });
      expect(teamPublicationBranch(db, thread.id)).toBe(branch);
      const isolated = teamRestores.find(db, thread.id, "restore-from-isolated")!;
      threads.update(db, thread.id, { branch: "openorc/team-" + thread.id + "-restore-" + isolated.id });
      expect(() => teamPublicationBranch(db, thread.id)).toThrow(/publication branch changed/);
      threads.update(db, thread.id, { branch });
      beginExecution();
      await completeExecution(async () => {});
      expect(current().branch).toBe(branch);
    } finally {
      await restore.shutdown();
    }
  });
});
