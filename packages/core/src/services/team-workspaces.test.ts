import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Db, orchestration, projects, tasks, teamRuntime, teamWorkspaces, threads } from "@openorc/db";
import { commitAll, git, teamTransfer } from "@openorc/git";
import type { Project, TeamActorRecord, TeamDraft, TeamExecutionRecord, Thread } from "@openorc/protocol";
import { TeamWorkspaceService } from "./team-workspaces.js";
import { WorkspaceWriters } from "./workspace-writers.js";
import { teamWorkspaceLocation } from "./team-workspace-location.js";

let directory: string;
let root: string;
let db: Db;
let project: Project;
let thread: Thread;
let execution: TeamExecutionRecord;
let service: TeamWorkspaceService;
let writers: WorkspaceWriters;
let fault: (point: string, receiptId: string, relativePath?: string) => Promise<void>;
const active = () => {};
const model = { agent: "codex" as const, model: "scripted-workspace-fixture", effort: "high", fastMode: false };

function actor(id: string, memberKey: string, taskId: string | null, parentId: string | null): TeamActorRecord {
  return {
    id,
    memberKey,
    taskId,
    parentId,
    requestKey: parentId ? id : null,
    requestHash: parentId ? `request-${id}` : null,
    dependencies: [],
    input: { title: `${memberKey} work`, spec: "Implement the assigned change", responsibility: "Work in the assigned workspace", attachments: [], settings: model },
    state: "queued",
    retries: 0,
    directionVersion: 0,
    deliveredVersion: 0,
    disposition: null,
    result: null,
    snapshotId: null,
    error: null,
  };
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "openorc-team-workspaces-"));
  root = path.join(directory, "repository");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "README.md"), "base heading\nbase detail\n");
  await writeFile(path.join(root, ".gitignore"), "private.env\n");
  await commitAll(root, "Fixture baseline");
  await writeFile(path.join(root, "README.md"), "staged heading\nbase detail\n");
  await git(root, ["add", "README.md"]);
  await writeFile(path.join(root, "README.md"), "staged heading\nunstaged detail\n");
  await writeFile(path.join(root, "parent-input.txt"), "Untracked parent input\n");
  await writeFile(path.join(root, "private.env"), "IGNORED_FIXTURE=1\n");
  db = Db.open(path.join(directory, "workspace.sqlite"));
  project = projects.insert(db, { name: "Workspace fixture", rootPath: root, gitRemote: null, defaultBranch: "main", settings: {} });
  thread = threads.insert(db, { projectId: project.id, title: "Integrate the team", ...model, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
  const draft: TeamDraft = {
    name: "Workspace team",
    limits: { maxConcurrentAgents: 3, maxAssignments: 12, maxExecutionMinutes: 60, maxAttemptsPerAssignment: 2 },
    discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
    members: [
      { key: "coordinator", name: "Lead", managerKey: null, responsibility: "Integrate", settings: model },
      { key: "engineer", name: "Engineer", managerKey: "coordinator", responsibility: "Implement", settings: model },
      { key: "reviewer", name: "Reviewer", managerKey: "coordinator", responsibility: "Verify", settings: model },
      { key: "worker-a", name: "Worker A", managerKey: "engineer", responsibility: "Implement the first manager assignment", settings: model },
      { key: "worker-b", name: "Worker B", managerKey: "engineer", responsibility: "Verify the first manager assignment", settings: model },
      { key: "other-worker", name: "Other worker", managerKey: "reviewer", responsibility: "Implement the independent branch", settings: model },
    ],
  };
  const saved = orchestration.save(db, { projectId: project.id, expectedRevisionId: null, draft });
  const instance = orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: saved.revision.id });
  const now = Date.now();
  execution = teamRuntime.create(db, {
    id: randomUUID(),
    instanceId: instance.id,
    threadId: thread.id,
    projectId: project.id,
    state: "active",
    generation: 1,
    revision: 0,
    limits: draft.limits,
    actors: [actor("lead", "coordinator", null, null)],
    attempts: [],
    messages: [],
    error: null,
    createdAt: now,
    updatedAt: now,
    deadlineAt: now + 3_600_000,
  });
  writers = new WorkspaceWriters();
  fault = async () => {};
  service = newService();
});

afterEach(async () => {
  await service?.shutdown();
  db?.close();
  vi.restoreAllMocks();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function newService(): TeamWorkspaceService {
  return new TeamWorkspaceService(db, { dataDir: path.join(directory, "data") }, writers, { fault: (point, receiptId, relativePath) => fault(point, receiptId, relativePath) });
}

function workspace(actorId = "lead") {
  const record = teamWorkspaces.get(db, execution.id, actorId);
  if (!record) throw new Error(`Missing durable workspace for ${actorId}`);
  return record;
}

function addWorker(memberKey: "engineer" | "reviewer" | "worker-a" | "worker-b" | "other-worker" = "engineer", parentId = "lead", dependencies: string[] = []): TeamActorRecord {
  return teamRuntime.update(db, execution.id, (current) => {
    const parent = current.actors.find((item) => item.id === parentId)!;
    const task = tasks.insert(db, {
      projectId: project.id,
      threadId: thread.id,
      title: `${memberKey} assignment`,
      spec: "Perform the assigned work",
      priority: "none",
      labels: [],
      workspaceMode: "worktree",
      baseRef: "main",
      parentTaskId: parent.taskId,
      origin: "agent",
    });
    const child = { ...actor(randomUUID(), memberKey, task.id, parentId), dependencies };
    current.actors.push(child);
    return child;
  }).value;
}

async function gitState(cwd: string) {
  const indexPath = (await git(cwd, ["rev-parse", "--git-path", "index"])).stdout.trim();
  return {
    head: (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim(),
    branch: (await git(cwd, ["symbolic-ref", "-q", "HEAD"], { okCodes: [0, 1] })).stdout.trim(),
    index: await readFile(path.resolve(cwd, indexPath)),
    staged: (await git(cwd, ["diff", "--cached", "--binary", "--full-index"])).stdout,
  };
}

async function finishWorker(worker: TeamActorRecord): Promise<void> {
  await service.captureOutput(execution.id, worker.id, active);
  teamRuntime.update(db, execution.id, (current) => {
    const completed = current.actors.find((candidate) => candidate.id === worker.id)!;
    completed.state = "completed";
    completed.result = `${worker.memberKey} finished`;
  });
}

async function preparedWorker(memberKey: "engineer" | "reviewer" = "engineer") {
  if (!teamWorkspaces.get(db, execution.id, "lead")) await service.prepare(execution.id, "lead", active);
  const worker = addWorker(memberKey);
  const prepared = await service.prepare(execution.id, worker.id, active);
  expect(prepared?.id).toBe(worker.taskId);
  return { worker, cwd: workspace(worker.id).path };
}

async function reopen(): Promise<void> {
  await service.shutdown();
  db.close();
  db = Db.open(path.join(directory, "workspace.sqlite"));
  writers = new WorkspaceWriters();
  service = newService();
  await service.recover();
}

/** Retained local lead history is ownership proof after a completed move. */
async function priorLocalExecution() {
  const source = await teamTransfer.capture(root, { refPrefix: "refs/openorc/tests/local-" + execution.id });
  const now = Date.now();
  const prior = teamWorkspaces.save(db, {
    id: randomUUID(),
    executionId: execution.id,
    actorId: "lead",
    taskId: null,
    parentActorId: null,
    path: project.rootPath,
    source,
    state: "ready",
    setupState: "completed",
    preparedTree: source.treeSha,
    outputTree: source.treeSha,
    error: null,
    createdAt: now,
    updatedAt: now,
  });
  threads.update(db, thread.id, { workspaceMode: "current", worktreePath: null, baseSha: source.headSha, branch: "openorc/team-" + thread.id });
  teamRuntime.update(db, execution.id, (record) => {
    record.state = "completed";
    record.actors[0]!.state = "completed";
  });
  execution = teamRuntime.create(db, { ...execution, id: randomUUID(), actors: [actor("lead", "coordinator", null, null)], createdAt: now, updatedAt: now, deadlineAt: now + 3_600_000 });
  return prior;
}

describe("durable team workspaces and publication", () => {
  it.each(["current", "worktree"] as const)("prepares a %s team while another conversation runs in its source checkout", async (workspaceMode) => {
    threads.update(db, thread.id, { workspaceMode });
    const other = await writers.acquire(root, "another conversation", undefined, { shared: true });
    try {
      const before = await gitState(root);
      await service.prepare(execution.id, "lead", active);
      expect(workspace().state).toBe("ready");
      expect(workspace().path === root).toBe(workspaceMode === "current");
      expect(await gitState(root)).toEqual(before);
      expect(await writers.reason([root])).toMatch(/another conversation/);
    } finally {
      other.release();
    }
  });

  it("starts locally without a worktree and retains ownership across restart and a later execution", async () => {
    threads.update(db, thread.id, { workspaceMode: "current" });
    projects.updateSettings(db, project.id, { setupScript: "printf unexpected > setup-ran.txt", worktreeInclude: ["private.env"] });
    const before = await gitState(root);
    await service.prepare(execution.id, "lead", active);
    const first = workspace();
    expect(first).toMatchObject({ path: root, state: "ready", setupState: "completed", preparedTree: first.source.treeSha });
    expect(threads.get(db, thread.id)).toMatchObject({ workspaceMode: "current", worktreePath: null, baseSha: before.head, branch: "main" });
    expect(teamWorkspaceLocation(db, thread.id)).toMatchObject({ path: root, trackedTree: first.source.treeSha });
    expect(await gitState(root)).toEqual(before);
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("staged heading\nunstaged detail\n");
    expect(await readFile(path.join(root, "parent-input.txt"), "utf8")).toBe("Untracked parent input\n");
    expect(await readFile(path.join(root, "private.env"), "utf8")).toBe("IGNORED_FIXTURE=1\n");
    await expect(lstat(path.join(root, "setup-ran.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(directory, "data", "team-workspaces"))).rejects.toMatchObject({ code: "ENOENT" });
    await service.captureOutput(execution.id, "lead", active);
    teamRuntime.update(db, execution.id, (record) => {
      record.state = "completed";
      record.actors[0]!.state = "completed";
    });
    await reopen();
    execution = teamRuntime.create(db, { ...execution, id: randomUUID(), actors: [actor("lead", "coordinator", null, null)] });
    await service.prepare(execution.id, "lead", active);
    expect(workspace().id).not.toBe(first.id);
    expect(teamWorkspaceLocation(db, thread.id).path).toBe(root);
    expect(await gitState(root)).toEqual(before);
    projects.updateSettings(db, project.id, { setupScript: null });
    const { worker, cwd } = await preparedWorker();
    expect(cwd).not.toBe(root);
    expect(workspace(worker.id).source.rootPath).toBe(await realpath(root));
    expect(await readFile(path.join(cwd, "parent-input.txt"), "utf8")).toBe("Untracked parent input\n");
    expect(await gitState(root)).toEqual(before);
  });

  it("refreshes an existing local workspace from HEAD instead of its historical source branch", async () => {
    threads.update(db, thread.id, { workspaceMode: "current" });
    await service.prepare(execution.id, "lead", active);
    const first = workspace();
    await git(root, ["checkout", "-q", "-b", "feature/current"]);
    await service.prepare(execution.id, "lead", active);
    expect(threads.get(db, thread.id)?.branch).toBe("feature/current");
    expect(workspace()).toEqual(first);
    await git(root, ["checkout", "-q", "--detach"]);
    await service.prepare(execution.id, "lead", active);
    expect(threads.get(db, thread.id)?.branch).toBeNull();
    expect(workspace()).toEqual(first);
  });

  it("isolates local lead children and publishes their output back while preserving checkout HEAD and partial staging", async () => {
    await priorLocalExecution();
    const before = await gitState(root);
    const { worker, cwd } = await preparedWorker();
    expect(cwd).not.toBe(root);
    expect(workspace(worker.id).source.rootPath).toBe(await realpath(root));
    await writeFile(path.join(cwd, "child-result.txt"), "Integrated child result\n");
    await finishWorker(worker);
    await service.integrate(execution.id, "lead", active);
    expect(await readFile(path.join(root, "child-result.txt"), "utf8")).toBe("Integrated child result\n");
    expect(await gitState(root)).toEqual(before);
    expect(teamWorkspaces.publications(db, execution.id)).toHaveLength(1);
    await service.integrate(execution.id, "lead", active);
    expect(teamWorkspaces.publications(db, execution.id)).toHaveLength(1);
    expect(threads.get(db, thread.id)?.workspaceMode).toBe("current");
  });

  it("reserves the local checkout against ordinary writers and retains inherited nowignored input across local executions", async () => {
    await priorLocalExecution();
    await writeFile(path.join(root, ".gitignore"), "private.env\nparent-input.txt\n");
    const writer = await writers.acquire(await realpath(root), "ordinary checkout writer");
    await expect(service.prepare(execution.id, "lead", active)).rejects.toThrow(/ordinary checkout writer/);
    expect(teamWorkspaces.get(db, execution.id, "lead")).toBeNull();
    writer.release();
    await service.prepare(execution.id, "lead", active);
    expect((await teamTransfer.listTree(root, workspace().preparedTree!)).map((entry) => entry.path)).toContain("parent-input.txt");
    const before = await gitState(root);
    const { worker, cwd } = await preparedWorker();
    expect(await readFile(path.join(cwd, "parent-input.txt"), "utf8")).toBe("Untracked parent input\n");
    expect(workspace(worker.id).path).not.toBe(root);
    expect(await gitState(root)).toEqual(before);
  });

  it("seeds an isolated lead with dirty parent input while preserving source HEAD and partial staging", async () => {
    const before = await gitState(root);
    const prepared = await service.prepare(execution.id, "lead", active);
    const lead = workspace();
    expect(prepared).toBeNull();
    expect(lead.path).not.toBe(root);
    expect(threads.get(db, thread.id)?.worktreePath).toBe(lead.path);
    expect(await readFile(path.join(lead.path, "README.md"), "utf8")).toBe("staged heading\nunstaged detail\n");
    expect(await readFile(path.join(lead.path, "parent-input.txt"), "utf8")).toBe("Untracked parent input\n");
    await expect(readFile(path.join(lead.path, "private.env"))).rejects.toThrow(/ENOENT/);
    expect(await gitState(root)).toEqual(before);
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("staged heading\nunstaged detail\n");
    expect(await service.prepare(execution.id, "lead", active)).toBeNull();
    expect(workspace().path).toBe(lead.path);
  });

  it("seeds each worker from its parent's current quiescent integration tree", async () => {
    await service.prepare(execution.id, "lead", active);
    const lead = workspace();
    await writeFile(path.join(lead.path, "lead-input.txt"), "The latest accepted parent state\n");
    const { worker, cwd } = await preparedWorker();
    expect(cwd).not.toBe(lead.path);
    expect(await readFile(path.join(cwd, "lead-input.txt"), "utf8")).toBe("The latest accepted parent state\n");
    expect(await readFile(path.join(cwd, "parent-input.txt"), "utf8")).toBe("Untracked parent input\n");
    expect(tasks.get(db, worker.taskId!)?.worktreePath).toBe(cwd);
    await expect(readFile(path.join(root, "lead-input.txt"))).rejects.toThrow(/ENOENT/);
    expect((await git(cwd, ["rev-parse", "HEAD"])).stdout).toBe((await git(lead.path, ["rev-parse", "HEAD"])).stdout);
  });

  it("seeds a dependent sibling from accepted manager input while isolating the other manager branch", async () => {
    await service.prepare(execution.id, "lead", active);
    const manager = addWorker();
    const otherManager = addWorker("reviewer");
    await service.prepare(execution.id, manager.id, active);
    await service.prepare(execution.id, otherManager.id, active);
    await writeFile(path.join(workspace(manager.id).path, "manager-private.txt"), "Only this branch receives this input\n");
    const first = addWorker("worker-a", manager.id);
    const independent = addWorker("other-worker", otherManager.id);
    await service.prepare(execution.id, first.id, active);
    await service.prepare(execution.id, independent.id, active);
    await writeFile(path.join(workspace(first.id).path, "first-result.txt"), "Verified dependency output\n");
    await finishWorker(first);
    await service.integrate(execution.id, manager.id, active);
    const dependent = addWorker("worker-b", manager.id, [first.id]);
    await service.prepare(execution.id, dependent.id, active);
    expect(await readFile(path.join(workspace(dependent.id).path, "first-result.txt"), "utf8")).toBe("Verified dependency output\n");
    expect(await readFile(path.join(workspace(dependent.id).path, "manager-private.txt"), "utf8")).toBe("Only this branch receives this input\n");
    for (const destination of [workspace().path, workspace(otherManager.id).path, workspace(independent.id).path]) {
      await expect(readFile(path.join(destination, "first-result.txt"))).rejects.toThrow(/ENOENT/);
      await expect(readFile(path.join(destination, "manager-private.txt"))).rejects.toThrow(/ENOENT/);
    }
    await writeFile(path.join(workspace(dependent.id).path, "dependent-result.txt"), "Checked the accepted first result\n");
    await finishWorker(dependent);
    await service.integrate(execution.id, manager.id, active);
    await finishWorker(manager);
    await service.integrate(execution.id, "lead", active);
    expect(await readFile(path.join(workspace().path, "dependent-result.txt"), "utf8")).toBe("Checked the accepted first result\n");
    await expect(readFile(path.join(workspace(independent.id).path, "first-result.txt"))).rejects.toThrow(/ENOENT/);
    expect(teamWorkspaces.publications(db, execution.id).find((receipt) => receipt.targetActorId === "lead")?.includedActorIds).toEqual([manager.id, first.id, dependent.id]);
  });

  it("preserves a failed grandchild's local files and fences cancelled manager publication until explicit recovery", async () => {
    await service.prepare(execution.id, "lead", active);
    const manager = addWorker();
    await service.prepare(execution.id, manager.id, active);
    const child = addWorker("worker-a", manager.id);
    await service.prepare(execution.id, child.id, active);
    const originalChild = workspace(child.id);
    await writeFile(path.join(originalChild.path, "a-retained-work.txt"), "Retain the failed attempt's useful work\n");
    teamRuntime.update(db, execution.id, (current) => {
      const failed = current.actors.find((item) => item.id === child.id)!;
      failed.state = "attention";
      failed.error = "Provider failed before completion";
    });
    await service.integrate(execution.id, manager.id, active);
    expect(workspace(child.id).outputTree).toBeNull();
    expect(teamWorkspaces.publications(db, execution.id)).toEqual([]);
    teamRuntime.update(db, execution.id, (current) => {
      const retried = current.actors.find((item) => item.id === child.id)!;
      retried.state = "queued";
      retried.retries++;
      retried.error = null;
    });
    await service.prepare(execution.id, child.id, active);
    expect(workspace(child.id).preparedTree).toBe(originalChild.preparedTree);
    expect(await readFile(path.join(workspace(child.id).path, "a-retained-work.txt"), "utf8")).toBe("Retain the failed attempt's useful work\n");
    await writeFile(path.join(workspace(child.id).path, "b-retried-result.txt"), "Retry finished the assignment\n");
    await finishWorker(child);
    const admittedGeneration = teamRuntime.get(db, execution.id)!.generation;
    fault = async (point) => {
      if (point === "after-write")
        teamRuntime.update(db, execution.id, (current) => {
          current.generation++;
          current.state = "attention";
        });
    };
    await expect(
      service.integrate(execution.id, manager.id, () => {
        if (teamRuntime.get(db, execution.id)!.generation !== admittedGeneration) throw new Error("The team was stopped");
      }),
    ).rejects.toThrow("The team was stopped");
    expect(await readFile(path.join(workspace(manager.id).path, "a-retained-work.txt"), "utf8")).toBe("Retain the failed attempt's useful work\n");
    await expect(readFile(path.join(workspace(manager.id).path, "b-retried-result.txt"))).rejects.toThrow(/ENOENT/);
    expect(() => service.assertStopped(execution.id)).toThrow(/recovery/);
    await reopen();
    await expect(writers.acquire(workspace(manager.id).path, "unrelated writer")).rejects.toThrow(/in use|reserv/i);
    expect(await readFile(path.join(workspace(child.id).path, "b-retried-result.txt"), "utf8")).toBe("Retry finished the assignment\n");
    fault = async () => {};
    await service.integrate(execution.id, manager.id, active);
    expect(() => service.assertStopped(execution.id)).not.toThrow();
    await finishWorker(manager);
    await service.integrate(execution.id, "lead", active);
    expect(await readFile(path.join(workspace().path, "b-retried-result.txt"), "utf8")).toBe("Retry finished the assignment\n");
    expect(teamWorkspaces.publications(db, execution.id)).toEqual([
      expect.objectContaining({ sourceActorId: child.id, targetActorId: manager.id, state: "applied" }),
      expect.objectContaining({ sourceActorId: manager.id, targetActorId: "lead", state: "applied" }),
    ]);
  });

  it("publishes binary, large, renamed, executable and symlink entries without changing the destination index", async () => {
    const { worker, cwd } = await preparedWorker();
    const binary = Buffer.from([0, 255, 254, 128, 0, 13, 10, 1]);
    const large = Buffer.alloc(2 * 1024 * 1024 + 7, 0xab);
    large[12345] = 0;
    const unusual = "file with spaces\tand a newline\n.bin";
    await writeFile(path.join(cwd, unusual), binary);
    await writeFile(path.join(cwd, "large.bin"), large);
    await rename(path.join(cwd, "parent-input.txt"), path.join(cwd, "renamed-input.txt"));
    await writeFile(path.join(cwd, "check.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(cwd, "check.sh"), 0o755);
    await symlink("renamed-input.txt", path.join(cwd, "input-link"));
    await finishWorker(worker);
    const destination = workspace().path;
    const before = await gitState(destination);
    await service.integrate(execution.id, "lead", active);
    expect(await readFile(path.join(destination, unusual))).toEqual(binary);
    expect(await readFile(path.join(destination, "large.bin"))).toEqual(large);
    expect(await readFile(path.join(destination, "renamed-input.txt"), "utf8")).toBe("Untracked parent input\n");
    await expect(readFile(path.join(destination, "parent-input.txt"))).rejects.toThrow(/ENOENT/);
    expect(await readlink(path.join(destination, "input-link"))).toBe("renamed-input.txt");
    expect((await lstat(path.join(destination, "check.sh"))).mode & 0o111).toBe(0o111);
    expect(await gitState(destination)).toEqual(before);
  });

  it("retains inherited untracked input a worker ignores, including when the same team starts its next execution", async () => {
    const { worker, cwd } = await preparedWorker();
    await writeFile(path.join(cwd, ".gitignore"), "private.env\nparent-input.txt\n");
    await finishWorker(worker);
    await service.integrate(execution.id, "lead", active);
    expect(await readFile(path.join(workspace().path, "parent-input.txt"), "utf8")).toBe("Untracked parent input\n");
    expect(teamWorkspaces.publications(db, execution.id)[0]?.entries.map((entry) => entry.path)).toEqual([".gitignore"]);
    await service.captureOutput(execution.id, "lead", active);
    const previous = workspace();
    const previousState = await gitState(previous.path);
    expect((await git(previous.path, ["check-ignore", "parent-input.txt"])).stdout.trim()).toBe("parent-input.txt");
    teamRuntime.update(db, execution.id, (current) => {
      current.actors.find((candidate) => candidate.id === "lead")!.state = "completed";
      current.state = "completed";
    });
    await reopen();
    const now = Date.now();
    execution = teamRuntime.create(db, {
      ...execution,
      id: randomUUID(),
      actors: [actor("lead", "coordinator", null, null)],
      createdAt: now,
      updatedAt: now,
      deadlineAt: now + 3_600_000,
    });
    await service.prepare(execution.id, "lead", active);
    const next = workspace();
    // The next execution continues in the same lead workspace; its tracked input is the previous output.
    expect(next.path).toBe(previous.path);
    expect(next.source).toEqual(previous.source);
    expect(next.preparedTree).toBe(previous.outputTree);
    expect(await readFile(path.join(next.path, "parent-input.txt"), "utf8")).toBe("Untracked parent input\n");
    expect(await readFile(path.join(next.path, ".gitignore"), "utf8")).toBe("private.env\nparent-input.txt\n");
    expect(await gitState(previous.path)).toEqual(previousState);
  });

  it("keeps conflicting worker results and scratch evidence without publishing conflict markers", async () => {
    const first = await preparedWorker();
    const second = await preparedWorker("reviewer");
    await writeFile(path.join(first.cwd, "README.md"), "Engineer replacement\n");
    await writeFile(path.join(second.cwd, "README.md"), "Reviewer replacement\n");
    await finishWorker(first.worker);
    await service.integrate(execution.id, "lead", active);
    await finishWorker(second.worker);
    const destination = workspace().path;
    const before = await gitState(destination);
    await expect(service.integrate(execution.id, "lead", active)).rejects.toThrow(/conflict/i);
    expect(await readFile(path.join(destination, "README.md"), "utf8")).toBe("Engineer replacement\n");
    expect(await gitState(destination)).toEqual(before);
    expect(await readFile(path.join(first.cwd, "README.md"), "utf8")).toBe("Engineer replacement\n");
    expect(await readFile(path.join(second.cwd, "README.md"), "utf8")).toBe("Reviewer replacement\n");
    const conflict = teamWorkspaces.publications(db, execution.id).find((receipt) => receipt.state === "conflict");
    expect(conflict?.sourceActorId).toBe(second.worker.id);
    expect((await lstat(conflict!.scratchPath)).isDirectory()).toBe(true);
    await expect(service.integrate(execution.id, "lead", active)).rejects.toThrow(/conflict/i);
    expect(teamWorkspaces.publications(db, execution.id)).toHaveLength(2);
  });

  it.each(["before-write", "before-receipt"])("detects an external touched-file edit at %s and preserves that edit", async (point) => {
    const { worker, cwd } = await preparedWorker();
    await writeFile(path.join(cwd, "README.md"), "Worker result\n");
    await finishWorker(worker);
    const destination = workspace().path;
    fault = async (current) => {
      if (current === point) await writeFile(path.join(destination, "README.md"), "External editor won the race\n");
    };
    await expect(service.integrate(execution.id, "lead", active)).rejects.toThrow(/chang|drift|conflict/i);
    expect(await readFile(path.join(destination, "README.md"), "utf8")).toBe("External editor won the race\n");
    expect(teamWorkspaces.publications(db, execution.id).every((receipt) => receipt.state !== "applied")).toBe(true);
    fault = async () => {};
    await reopen();
    await expect(service.integrate(execution.id, "lead", active)).rejects.toThrow(/chang|drift|conflict/i);
    expect(await readFile(path.join(destination, "README.md"), "utf8")).toBe("External editor won the race\n");
  });

  it("creates a missing parent for published output", async () => {
    const { worker, cwd } = await preparedWorker();
    await mkdir(path.join(cwd, "nested"));
    await writeFile(path.join(cwd, "nested", "result.txt"), "Worker output\n");
    await finishWorker(worker);
    const destination = workspace().path;
    await expect(lstat(path.join(destination, "nested"))).rejects.toThrow(/ENOENT/);
    await service.integrate(execution.id, "lead", active);
    expect(await readFile(path.join(destination, "nested", "result.txt"), "utf8")).toBe("Worker output\n");
  });

  it("rejects a symlink parent inserted before publication and retains recovery evidence", async () => {
    const { worker, cwd } = await preparedWorker();
    await mkdir(path.join(cwd, "nested"));
    await writeFile(path.join(cwd, "nested", "result.txt"), "Worker output\n");
    await finishWorker(worker);
    const destination = workspace().path;
    const outside = path.join(directory, "outside");
    await mkdir(outside);
    const before = await gitState(destination);
    fault = async (point, _receiptId, file) => {
      if (point === "before-write" && file === "nested/result.txt") await symlink(outside, path.join(destination, "nested"));
    };
    await expect(service.integrate(execution.id, "lead", active)).rejects.toThrow(/Unsafe parent directory/);
    expect(await gitState(destination)).toEqual(before);
    await expect(readFile(path.join(outside, "result.txt"))).rejects.toThrow(/ENOENT/);
    expect(teamWorkspaces.publications(db, execution.id).every((receipt) => receipt.state !== "applied")).toBe(true);
    fault = async () => {};
    await reopen();
    await expect(service.integrate(execution.id, "lead", active)).rejects.toThrow(/Unsafe parent directory/);
    await expect(readFile(path.join(outside, "result.txt"))).rejects.toThrow(/ENOENT/);
  });

  it.each(["before-receipt", "after-receipt"])("recovers a %s interruption with one durable receipt and unchanged staging", async (point) => {
    const { worker, cwd } = await preparedWorker();
    await writeFile(path.join(cwd, "a-result.txt"), "First output\n");
    await writeFile(path.join(cwd, "b-result.txt"), "Second output\n");
    await finishWorker(worker);
    const destination = workspace().path;
    const before = await gitState(destination);
    let interrupted = false;
    fault = async (current) => {
      if (current === point && !interrupted) {
        interrupted = true;
        throw new Error(`Injected interruption ${point}`);
      }
    };
    await expect(service.integrate(execution.id, "lead", active)).rejects.toThrow(/Injected interruption/);
    expect(interrupted).toBe(true);
    const receiptId = teamWorkspaces.publications(db, execution.id)[0]!.id;
    if (point === "after-write") {
      expect(await readFile(path.join(destination, "a-result.txt"), "utf8")).toBe("First output\n");
      await expect(readFile(path.join(destination, "b-result.txt"))).rejects.toThrow(/ENOENT/);
    }
    fault = async () => {};
    await reopen();
    expect(await gitState(destination)).toEqual(before);
    const receipt = teamWorkspaces.publication(db, receiptId)!;
    if (receipt.state !== "applied") await expect(writers.acquire(destination, "unrelated writer")).rejects.toThrow(/in use|reserv/i);
    await service.integrate(execution.id, "lead", active);
    expect(await readFile(path.join(destination, "a-result.txt"), "utf8")).toBe("First output\n");
    expect(await readFile(path.join(destination, "b-result.txt"), "utf8")).toBe("Second output\n");
    expect(teamWorkspaces.publications(db, execution.id)).toEqual([expect.objectContaining({ id: receiptId, state: "applied" })]);
    expect(await gitState(destination)).toEqual(before);
    await service.integrate(execution.id, "lead", active);
    expect(teamWorkspaces.publications(db, execution.id)).toHaveLength(1);
    const released = await writers.acquire(destination, "ordinary writer after publication");
    released.release();
  });

  it("preserves unrelated work during publication and rejects changed staging", async () => {
    const { worker, cwd } = await preparedWorker();
    await writeFile(path.join(cwd, "worker-result.txt"), "Worker output\n");
    await finishWorker(worker);
    const destination = workspace().path;
    await writeFile(path.join(destination, "unrelated.txt"), "User work predating publication\n");
    fault = async (point) => {
      if (point === "after-plan") {
        await writeFile(path.join(destination, "new-staged.txt"), "New staging by external Git command\n");
        await git(destination, ["add", "new-staged.txt"]);
      }
    };
    await expect(service.integrate(execution.id, "lead", active)).rejects.toThrow(/index|stag|chang|drift/i);
    expect(await readFile(path.join(destination, "unrelated.txt"), "utf8")).toBe("User work predating publication\n");
    expect((await git(destination, ["diff", "--cached", "--name-only"])).stdout).toContain("new-staged.txt");
    await expect(readFile(path.join(destination, "worker-result.txt"))).rejects.toThrow(/ENOENT/);
  });

  it("blocks source-changing setup and does not silently accept the existing workspace on retry", async () => {
    projects.updateSettings(db, project.id, { setupScript: 'printf "setup changed source\\n" > README.md' });
    const before = await gitState(root);
    await expect(service.prepare(execution.id, "lead", active)).rejects.toThrow(/setup/i);
    const blocked = workspace();
    expect(blocked).toMatchObject({ state: "attention", setupState: "blocked", preparedTree: expect.any(String) });
    expect(await readFile(path.join(blocked.path, "README.md"), "utf8")).toBe("setup changed source\n");
    expect(await gitState(root)).toEqual(before);
    await expect(service.prepare(execution.id, "lead", active)).rejects.toThrow(/setup|attention|recover/i);
    expect(workspace().preparedTree).toBe(blocked.preparedTree);
  });

  it("retains failed setup for inspection across restart and never reruns it implicitly", async () => {
    projects.updateSettings(db, project.id, { setupScript: 'printf "attempt\\n" >> private.env; exit 7' });
    await expect(service.prepare(execution.id, "lead", active)).rejects.toThrow(/setup|7/i);
    const failed = workspace();
    expect(failed.state).toBe("attention");
    expect(await readFile(path.join(failed.path, "private.env"), "utf8")).toBe("attempt\n");
    await reopen();
    await expect(service.prepare(execution.id, "lead", active)).rejects.toThrow(/setup|attention|recover/i);
    expect(await readFile(path.join(failed.path, "private.env"), "utf8")).toBe("attempt\n");
  });

  it("permits setup that only writes declared ignored runtime artifacts", async () => {
    projects.updateSettings(db, project.id, { setupScript: 'printf "ready\\n" > private.env' });
    await service.prepare(execution.id, "lead", active);
    expect(workspace()).toMatchObject({ state: "ready", setupState: "completed" });
    expect(workspace().preparedTree).toBe(workspace().source.treeSha);
    expect(await readFile(path.join(workspace().path, "private.env"), "utf8")).toBe("ready\n");
  });

  it("cancels an in-progress setup process before releasing its workspace reservation", async () => {
    projects.updateSettings(db, project.id, { setupScript: 'printf "started\\n" > private.env; while :; do sleep 1; done' });
    let admitted = true;
    const preparing = service.prepare(execution.id, "lead", () => {
      if (!admitted) throw new Error("Setup execution cancelled");
    });
    try {
      await vi.waitFor(async () => expect(await readFile(path.join(workspace().path, "private.env"), "utf8")).toBe("started\n"));
      await expect(writers.acquire(workspace().path, "writer during setup")).rejects.toThrow(/in use|reserv/i);
      admitted = false;
      await expect(preparing).rejects.toThrow("Setup execution cancelled");
      expect(workspace()).toMatchObject({ state: "attention", setupState: "blocked" });
      const available = await writers.acquire(workspace().path, "inspection after confirmed setup exit");
      available.release();
    } finally {
      admitted = false;
      await preparing.catch(() => {});
    }
  });

  it("finishes local team output capture while another conversation is using the checkout", async () => {
    threads.update(db, thread.id, { workspaceMode: "current" });
    await service.prepare(execution.id, "lead", active);
    const before = await gitState(root);
    const otherConversation = await writers.acquire(root, "Unrelated conversation", undefined, { shared: true });
    // A greeting must not wait for or close unrelated conversations to finish its read-only snapshot.
    writers.onConflict(async () => {
      throw new Error("Output capture is waiting for an unrelated conversation");
    });
    try {
      await expect(service.captureOutput(execution.id, "lead", active)).resolves.toBeUndefined();
      expect(workspace().outputTree).toBeTruthy();
      expect(await gitState(root)).toEqual(before);
      expect(await writers.reason([root])).toContain("Unrelated conversation");
    } finally {
      otherConversation.release();
    }
  });

  it("still refuses a local output snapshot during an exclusive checkout operation", async () => {
    threads.update(db, thread.id, { workspaceMode: "current" });
    await service.prepare(execution.id, "lead", active);
    const exclusive = await writers.acquire(root, "Restore checkout");
    try {
      await expect(service.captureOutput(execution.id, "lead", active)).rejects.toThrow(/in use by Restore checkout/);
      expect(workspace().outputTree).toBeNull();
    } finally {
      exclusive.release();
    }
    await service.captureOutput(execution.id, "lead", active);
    expect(workspace().outputTree).toBeTruthy();
  });

  it.each(["current", "worktree"] as const)("respects ordinary writers during %s preparation, output capture and integration", async (workspaceMode) => {
    threads.update(db, thread.id, { workspaceMode });
    const sourceLease = await writers.acquire(root, "ordinary source writer");
    try {
      await expect(service.prepare(execution.id, "lead", active)).rejects.toThrow(/in use|reserv/i);
      expect(teamWorkspaces.list(db)).toEqual([]);
    } finally {
      sourceLease.release();
    }
    const { worker, cwd } = await preparedWorker();
    await writeFile(path.join(cwd, "result.txt"), "Immutable worker result\n");
    const workerLease = await writers.acquire(cwd, "worker still finishing");
    try {
      await expect(service.captureOutput(execution.id, worker.id, active)).rejects.toThrow(/in use|reserv/i);
      expect(workspace(worker.id).outputTree).toBeNull();
    } finally {
      workerLease.release();
    }
    await finishWorker(worker);
    const destinationLease = await writers.acquire(workspace().path, "lead still running");
    try {
      await expect(service.integrate(execution.id, "lead", active)).rejects.toThrow(/in use|reserv/i);
      expect(teamWorkspaces.publications(db, execution.id)).toEqual([]);
    } finally {
      destinationLease.release();
    }
    await service.integrate(execution.id, "lead", active);
    expect(await readFile(path.join(workspace().path, "result.txt"), "utf8")).toBe("Immutable worker result\n");
  });
});

describe("explicit setup and integration recovery", () => {
  const context = { assertActive() {}, assertActorIdle() {} };
  const setupGate = 'test -f "$OPENORC_ROOT_PATH/.setup-ok" || { printf "attempt\\n" >> private.env; exit 7; }';

  it("retries failed setup in a new directory with the same captured input and keeps the failed directory", async () => {
    projects.updateSettings(db, project.id, { setupScript: setupGate });
    await expect(service.prepare(execution.id, "lead", active)).rejects.toThrow(/7/);
    const failed = workspace();
    expect(service.setupRecovery(execution.id, "lead", context)).toEqual({
      retrySetup: { allowed: true, reason: null },
      acceptSetup: { allowed: false, reason: expect.stringMatching(/nothing to accept/) },
      sourceChanged: false,
      retiredPaths: [],
    });
    await expect(service.acceptSetup(execution.id, "lead", "accept-1", context)).rejects.toThrow(/nothing to accept/);
    await writeFile(path.join(root, "parent-input.txt"), "Changed after capture\n");
    await writeFile(path.join(root, ".setup-ok"), "");
    await service.retrySetup(execution.id, "lead", "retry-1", context);
    const ready = workspace();
    expect(ready).toMatchObject({
      id: failed.id,
      state: "ready",
      setupState: "completed",
      preparedTree: failed.source.treeSha,
      source: failed.source,
      retired: [{ path: failed.path, preparedTree: null, error: expect.stringMatching(/7/), retiredAt: expect.any(Number) }],
      recovery: [{ requestKey: "retry-1", kind: "retry-setup", createdAt: expect.any(Number) }],
    });
    expect(ready.path).not.toBe(failed.path);
    expect(await readFile(path.join(failed.path, "private.env"), "utf8")).toBe("attempt\n");
    await expect(readFile(path.join(ready.path, "private.env"))).rejects.toThrow(/ENOENT/);
    // The retry uses the original captured input, not the source as it is now.
    expect(await readFile(path.join(ready.path, "parent-input.txt"), "utf8")).toBe("Untracked parent input\n");
    expect(await readFile(path.join(ready.path, "README.md"), "utf8")).toBe("staged heading\nunstaged detail\n");
    expect(threads.get(db, thread.id)?.worktreePath).toBe(ready.path);
    await service.retrySetup(execution.id, "lead", "retry-1", context);
    expect(workspace()).toEqual(ready);
    await expect(service.retrySetup(execution.id, "lead", "retry-2", context)).rejects.toThrow(/not blocked/i);
    expect(service.setupRecovery(execution.id, "lead", context)).toBeUndefined();
    await service.prepare(execution.id, "lead", active);
    expect(workspace()).toEqual(ready);
  });

  it("accepts source-changing setup as the assignment input and measures later results from the prepared tree", async () => {
    projects.updateSettings(db, project.id, { setupScript: 'printf "setup changed source\\n" > README.md' });
    await expect(service.prepare(execution.id, "lead", active)).rejects.toThrow(/setup changed source/i);
    const blocked = workspace();
    expect(blocked).toMatchObject({ state: "attention", setupState: "blocked", setupChangedSource: true });
    expect(service.setupRecovery(execution.id, "lead", context)).toMatchObject({ retrySetup: { allowed: true }, acceptSetup: { allowed: true }, sourceChanged: true });
    await writeFile(path.join(blocked.path, "edited-after-block.txt"), "Manual edit\n");
    await expect(service.acceptSetup(execution.id, "lead", "accept-1", context)).rejects.toThrow(/changed after setup/);
    expect(workspace().state).toBe("attention");
    await rm(path.join(blocked.path, "edited-after-block.txt"));
    await service.acceptSetup(execution.id, "lead", "accept-1", context);
    const accepted = workspace();
    expect(accepted).toMatchObject({
      state: "ready",
      setupState: "completed",
      path: blocked.path,
      preparedTree: blocked.preparedTree,
      setupAccepted: { sourceTree: blocked.source.treeSha, preparedTree: blocked.preparedTree, acceptedAt: expect.any(Number) },
      recovery: [{ requestKey: "accept-1", kind: "accept-setup", createdAt: expect.any(Number) }],
    });
    expect(accepted.preparedTree).not.toBe(accepted.source.treeSha);
    expect(() => teamWorkspaces.save(db, { ...accepted, setupAccepted: null })).toThrow(/immutable/);
    await service.acceptSetup(execution.id, "lead", "accept-1", context);
    projects.updateSettings(db, project.id, { setupScript: null });
    const { worker, cwd } = await preparedWorker();
    expect(await readFile(path.join(cwd, "README.md"), "utf8")).toBe("setup changed source\n");
    await writeFile(path.join(cwd, "worker-result.txt"), "Worker output\n");
    await finishWorker(worker);
    await service.integrate(execution.id, "lead", active);
    const receipt = teamWorkspaces.publications(db, execution.id)[0]!;
    expect(receipt.state).toBe("applied");
    expect(receipt.entries.map((entry) => entry.path)).toEqual(["worker-result.txt"]);
    await service.captureOutput(execution.id, "lead", active);
    const output = await teamTransfer.listTree(root, workspace().outputTree!);
    const prepared = await teamTransfer.listTree(root, accepted.preparedTree!);
    expect(output.find((entry) => entry.path === "README.md")).toEqual(prepared.find((entry) => entry.path === "README.md"));
  });

  async function conflictingWorkers() {
    const first = await preparedWorker();
    const second = await preparedWorker("reviewer");
    await writeFile(path.join(first.cwd, "README.md"), "Engineer replacement\n");
    await writeFile(path.join(second.cwd, "README.md"), "Reviewer replacement\n");
    await finishWorker(first.worker);
    await service.integrate(execution.id, "lead", active);
    await finishWorker(second.worker);
    await expect(service.integrate(execution.id, "lead", active)).rejects.toThrow(/conflict/i);
    const conflict = teamWorkspaces.publications(db, execution.id).find((receipt) => receipt.state === "conflict")!;
    expect(conflict.conflicts).toEqual(["README.md"]);
    return { conflict, destination: workspace().path };
  }

  it("accepts a hand-resolved conflict from the scratch worktree and refuses leftover markers", async () => {
    const { conflict, destination } = await conflictingWorkers();
    const before = await gitState(destination);
    expect(service.integrationRecovery(conflict, context)).toEqual({
      retry: { allowed: true, reason: null },
      accept: { allowed: true, reason: null },
      conflicts: ["README.md"],
      retiredScratchPaths: [],
    });
    expect(await readFile(path.join(conflict.scratchPath, "README.md"), "utf8")).toMatch(/^<{7}/m);
    await expect(service.acceptIntegration(execution.id, conflict.id, "accept-1", context)).rejects.toThrow(/conflict markers in README.md/);
    expect(teamWorkspaces.publication(db, conflict.id)?.state).toBe("conflict");
    await writeFile(path.join(conflict.scratchPath, "README.md"), "Engineer replacement\nReviewer replacement\n");
    await writeFile(path.join(conflict.scratchPath, "notes-from-resolution.txt"), "Added while resolving\n");
    await service.acceptIntegration(execution.id, conflict.id, "accept-1", context);
    const applied = teamWorkspaces.publication(db, conflict.id)!;
    expect(applied).toMatchObject({ state: "applied", afterTree: expect.any(String), recovery: [{ requestKey: "accept-1", kind: "accept-integration", createdAt: expect.any(Number) }] });
    expect(applied.entries.map((entry) => entry.path).sort()).toEqual(["README.md", "notes-from-resolution.txt"]);
    expect(await readFile(path.join(destination, "README.md"), "utf8")).toBe("Engineer replacement\nReviewer replacement\n");
    expect(await readFile(path.join(destination, "notes-from-resolution.txt"), "utf8")).toBe("Added while resolving\n");
    expect(await gitState(destination)).toEqual(before);
    expect(service.integrationRecovery(applied, context)).toBeUndefined();
    await service.acceptIntegration(execution.id, conflict.id, "accept-1", context);
    await service.integrate(execution.id, "lead", active);
    expect(teamWorkspaces.publications(db, execution.id).map((receipt) => receipt.state)).toEqual(["applied", "applied"]);
    const released = await writers.acquire(destination, "ordinary writer after acceptance");
    released.release();
  });

  it("retries a conflicting integration in a new scratch directory after the destination was changed by hand", async () => {
    const { conflict, destination } = await conflictingWorkers();
    await writeFile(path.join(destination, "README.md"), "Reviewer replacement\n");
    await service.retryIntegration(execution.id, conflict.id, "retry-1", context);
    const applied = teamWorkspaces.publication(db, conflict.id)!;
    expect(applied).toMatchObject({ state: "applied", retiredScratchPaths: [conflict.scratchPath], conflicts: [], entries: [] });
    expect(applied.scratchPath).not.toBe(conflict.scratchPath);
    expect(applied.before.treeSha).not.toBe(conflict.before.treeSha);
    expect((await lstat(conflict.scratchPath)).isDirectory()).toBe(true);
    expect(await readFile(path.join(conflict.scratchPath, "README.md"), "utf8")).toMatch(/^<{7}/m);
    expect(() => teamWorkspaces.savePublication(db, { ...applied, retiredScratchPaths: [] })).toThrow(/immutable/);
    await service.retryIntegration(execution.id, conflict.id, "retry-1", context);
    await service.integrate(execution.id, "lead", active);
  });

  it("retries an interrupted merge whose scratch directory already exists instead of trusting it", async () => {
    const { worker, cwd } = await preparedWorker();
    await writeFile(path.join(cwd, "worker-result.txt"), "Worker output\n");
    await finishWorker(worker);
    fault = async (point, receiptId) => {
      if (point === "after-plan") await mkdir(teamWorkspaces.publication(db, receiptId)!.scratchPath, { recursive: true });
    };
    await expect(service.integrate(execution.id, "lead", active)).rejects.toThrow(/Interrupted scratch integration/);
    fault = async () => {};
    const interrupted = teamWorkspaces.publications(db, execution.id)[0]!;
    expect(interrupted).toMatchObject({ state: "attention", afterTree: null });
    expect(service.integrationRecovery(interrupted, context)).toMatchObject({ retry: { allowed: true }, accept: { allowed: false, reason: expect.stringMatching(/conflicting integration/) } });
    await reopen();
    await service.retryIntegration(execution.id, interrupted.id, "retry-1", context);
    const applied = teamWorkspaces.publication(db, interrupted.id)!;
    expect(applied).toMatchObject({ state: "applied", retiredScratchPaths: [interrupted.scratchPath] });
    expect(await readFile(path.join(workspace().path, "worker-result.txt"), "utf8")).toBe("Worker output\n");
    const released = await writers.acquire(workspace().path, "ordinary writer after recovery");
    released.release();
  });

  it("counts a running setup retry as a writer and refuses a concurrent recovery", async () => {
    projects.updateSettings(db, project.id, { setupScript: setupGate });
    await expect(service.prepare(execution.id, "lead", active)).rejects.toThrow(/7/);
    projects.updateSettings(db, project.id, { setupScript: 'until test -f "$OPENORC_ROOT_PATH/.release"; do sleep 0.05; done' });
    const running = service.retrySetup(execution.id, "lead", "slow-retry", context);
    await vi.waitFor(() => expect(workspace().setupState).toBe("running"));
    expect(service.pendingRecoveries(execution.id)).toHaveLength(1);
    expect(() => service.assertStopped(execution.id)).toThrow(/recovery is still running/);
    expect(service.setupRecovery(execution.id, "lead", context)).toBeUndefined();
    await expect(service.acceptSetup(execution.id, "lead", "other", context)).rejects.toThrow(/already in progress/);
    await expect(service.retrySetup(execution.id, "lead", "other", context)).rejects.toThrow(/already in progress/);
    const rejoined = service.retrySetup(execution.id, "lead", "slow-retry", context);
    await writeFile(path.join(root, ".release"), "");
    await Promise.all([running, rejoined]);
    expect(workspace()).toMatchObject({ state: "ready", setupState: "completed", recovery: [{ requestKey: "slow-retry", kind: "retry-setup" }] });
    expect(service.pendingRecoveries(execution.id)).toEqual([]);
    expect(() => service.assertStopped(execution.id)).not.toThrow();
  });
});
