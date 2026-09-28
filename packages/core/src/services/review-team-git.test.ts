import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Db, orchestration, projects, tasks, teamRuntime, teamWorkspaces, threads } from "@openorc/db";
import * as gitTools from "@openorc/git";
import { DEFAULT_TEAM_LIMITS, type Project, type TeamExecutionRecord, type Thread } from "@openorc/protocol";
import { ReviewService, type ReviewTeamMutations } from "./review.js";
import { WorkspaceWriters } from "./workspace-writers.js";

let db: Db;
let directory: string;
let project: Project;
let thread: Thread;
let execution: TeamExecutionRecord;
let cwd: string;
let bare: string;
let base: string;
let writers: WorkspaceWriters;
let review: ReviewService;
let blocked: string | null;
let reserved: boolean;
let guard: ReviewTeamMutations;
const settings = { agent: "codex" as const, model: "fixture-astra", effort: "high", fastMode: false };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "openorc-team-git-"));
  const root = path.join(directory, "repository");
  bare = path.join(directory, "remote.git");
  cwd = path.join(directory, "lead");
  await mkdir(root);
  await gitTools.git(root, ["init", "-q", "-b", "main"]);
  await gitTools.git(root, ["config", "user.email", "fixture@example.com"]);
  await gitTools.git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "README.md"), "# Baseline\n");
  base = await gitTools.commitAll(root, "Baseline");
  await gitTools.git(root, ["init", "--bare", "-q", bare]);
  await gitTools.git(root, ["remote", "add", "origin", bare]);
  await gitTools.git(root, ["push", "-u", "origin", "main"]);
  await gitTools.git(root, ["worktree", "add", "--detach", cwd, base]);
  db = Db.memory();
  project = projects.insert(db, { name: "Team Git", rootPath: root, defaultBranch: "main", gitRemote: bare, settings: {} });
  thread = threads.insert(db, { projectId: project.id, title: "Integrated team work", ...settings, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
  thread = threads.update(db, thread.id, { worktreePath: cwd, baseSha: base });
  const team = orchestration.save(db, {
    projectId: project.id,
    expectedRevisionId: null,
    draft: {
      name: "Publication team",
      limits: { ...DEFAULT_TEAM_LIMITS },
      discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
      members: [
        { key: "lead", name: "Lead", managerKey: null, responsibility: "Coordinate", settings },
        { key: "worker", name: "Worker", managerKey: "lead", responsibility: "Implement", settings },
      ],
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
        taskId: null,
        parentId: null,
        requestKey: null,
        requestHash: null,
        dependencies: [],
        input: { title: "Integrated result", spec: "Work", attachments: [], responsibility: "Coordinate", settings },
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
    deadlineAt: now + 3600000,
  });
  const source = await gitTools.teamTransfer.capture(project.rootPath, { refPrefix: `refs/openorc/tests/${execution.id}` });
  teamWorkspaces.save(db, {
    id: randomUUID(),
    executionId: execution.id,
    actorId: "lead",
    taskId: null,
    parentActorId: null,
    path: cwd,
    source,
    state: "ready",
    setupState: "completed",
    preparedTree: source.treeSha,
    outputTree: source.treeSha,
    error: null,
    createdAt: now,
    updatedAt: now,
  });
  teamRuntime.update(db, execution.id, (record) => {
    record.state = "completed";
    record.actors[0]!.state = "completed";
  });
  blocked = null;
  reserved = false;
  guard = {
    reason: () => blocked ?? (reserved ? "Another team operation is active" : null),
    reserve() {
      if (blocked) throw new Error(blocked);
      if (reserved) throw new Error("Another team operation is active");
      reserved = true;
      return {
        assertCurrent() {
          if (blocked) throw new Error(blocked);
          if (!reserved) throw new Error("Reservation expired");
        },
        release() {
          reserved = false;
        },
      };
    },
  };
  writers = new WorkspaceWriters();
  review = new ReviewService(db, writers, guard);
  vi.spyOn(gitTools, "hasGh").mockResolvedValue(true);
  vi.spyOn(gitTools, "createPr").mockResolvedValue("https://example.invalid/pull/1");
});
afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await rm(directory, { recursive: true, force: true });
});
const branch = () => `openorc/team-${thread.id}`;
const head = async (root = cwd) => (await gitTools.git(root, ["rev-parse", "HEAD"])).stdout.trim();

async function change() {
  await writeFile(path.join(cwd, "team.txt"), "Combined team result\n");
}
async function remoteHead() {
  return (await gitTools.git(project.rootPath, ["ls-remote", "origin", `refs/heads/${branch()}`])).stdout.trim().split(/\s/)[0] ?? "";
}

async function localLead() {
  const source = await gitTools.teamTransfer.capture(project.rootPath, { refPrefix: "refs/openorc/tests/local-" + randomUUID() });
  const now = Date.now();
  const local = teamRuntime.create(db, { ...execution, id: randomUUID(), revision: 0, createdAt: now, updatedAt: now, deadlineAt: now + 3_600_000 });
  teamWorkspaces.save(db, {
    id: randomUUID(),
    executionId: local.id,
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
  teamRuntime.update(db, local.id, (record) => {
    record.state = "completed";
    record.actors[0]!.state = "completed";
  });
  threads.update(db, thread.id, { workspaceMode: "current", worktreePath: null, baseSha: source.headSha, branch: branch() });
  return local;
}

describe("publishing an integrated team workspace", () => {
  it.each(["legacy"])("commits and pushes a local lead with %s metadata on its actual branch without advancing its old publication ref", async (metadata) => {
    await localLead();
    const savedBranch = metadata === "checkout" ? "main" : branch();
    threads.update(db, thread.id, { branch: savedBranch });
    await gitTools.git(project.rootPath, ["update-ref", "refs/heads/" + branch(), base]);
    await writeFile(path.join(project.rootPath, "local-team.txt"), "Local team result\n");
    expect(review.teamActionAvailability(thread.id)).toEqual({ allowed: true, reason: null });
    const committed = await review.commitThread(thread, project, "Local team result");
    expect(await head(project.rootPath)).toBe(committed.sha);
    expect(await head(cwd)).toBe(base);
    expect((await gitTools.git(project.rootPath, ["symbolic-ref", "--short", "HEAD"])).stdout.trim()).toBe("main");
    expect((await gitTools.git(project.rootPath, ["rev-parse", "refs/heads/" + branch()])).stdout.trim()).toBe(base);
    expect(threads.get(db, thread.id)?.branch).toBe(savedBranch);
    expect(await review.pushThread(thread, project)).toEqual({ remote: "origin", branch: "main" });
    expect((await gitTools.git(project.rootPath, ["ls-remote", "origin", "refs/heads/main"])).stdout.trim().split(/\s/)[0]).toBe(committed.sha);
    expect(await remoteHead()).toBe("");
    await expect(review.createThreadPr(thread, project, "Main PR", "", "main")).rejects.toThrow(/needs a branch of its own/);
  });

  it("uses a local checkout feature branch for PRs while preserving team guards and physical writer exclusion", async () => {
    await gitTools.git(project.rootPath, ["checkout", "-b", "local-feature"]);
    await localLead();
    await writeFile(path.join(project.rootPath, "feature.txt"), "Requested local feature\n");
    const writer = await writers.acquire(project.rootPath, "ordinary local provider");
    await expect(review.commitThread(thread, project, "Blocked")).rejects.toThrow(/ordinary local provider/);
    writer.release();
    blocked = "Unfinished team child";
    await expect(review.pushThread(thread, project)).rejects.toThrow(/Unfinished team child/);
    blocked = null;
    await review.commitThread(thread, project, "Feature");
    await review.pushThread(thread, project);
    expect(await review.createThreadPr(thread, project, "Local feature PR", "Requested", "main")).toEqual({ url: "https://example.invalid/pull/1" });
    const physical = (await gitTools.git(project.rootPath, ["rev-parse", "--show-toplevel"])).stdout.trim();
    expect(gitTools.createPr).toHaveBeenCalledWith(physical, { title: "Local feature PR", body: "Requested", base: "main", head: "local-feature" });
    expect(reserved).toBe(false);
    expect(await remoteHead()).toBe("");
  });

  it("rejects a current-mode pointer without owned local workspace provenance", async () => {
    threads.update(db, thread.id, { workspaceMode: "current", worktreePath: null });
    await expect(review.commitThread(thread, project, "No retained local work")).rejects.toThrow(/not retained/);
    expect(await head(project.rootPath)).toBe(base);
    expect(await remoteHead()).toBe("");
  });

  it("projects availability from retained readiness and the live guard without native Git probes", () => {
    expect(review.teamActionAvailability(thread.id)).toEqual({ allowed: true, reason: null });
    blocked = "Pending approval";
    expect(review.teamActionAvailability(thread.id)).toEqual({ allowed: false, reason: "Pending approval" });
    blocked = null;
    const record = teamWorkspaces.get(db, execution.id, "lead")!;
    teamWorkspaces.save(db, { ...record, state: "attention", error: "Needs recovery" });
    expect(review.teamActionAvailability(thread.id)).toMatchObject({ allowed: false, reason: expect.stringContaining("ready integrated") });
    expect(reserved).toBe(false);
    expect(gitTools.hasGh).not.toHaveBeenCalled();
    expect(gitTools.createPr).not.toHaveBeenCalled();
  });

  it("commits only the isolated lead workspace and advances its dedicated local ref without pushing", async () => {
    await change();
    await writeFile(path.join(project.rootPath, "user.txt"), "Unrelated checkout work\n");
    const result = await review.commitThread(thread, project, "Integrate the team result");
    expect(result.sha).not.toBe(base);
    expect(await head(project.rootPath)).toBe(base);
    expect(await gitTools.git(cwd, ["symbolic-ref", "-q", "HEAD"], { okCodes: [0, 1] })).toMatchObject({ code: 1 });
    expect((await gitTools.git(cwd, ["rev-parse", `refs/heads/${branch()}`])).stdout.trim()).toBe(result.sha);
    expect(threads.get(db, thread.id)?.branch).toBe(branch());
    expect(await remoteHead()).toBe("");
    expect(await readFile(path.join(project.rootPath, "user.txt"), "utf8")).toBe("Unrelated checkout work\n");
    expect(reserved).toBe(false);
  });

  it("pushes the explicit team branch to a disposable local remote without committing pending files", async () => {
    await change();
    const committed = await review.commitThread(thread, project, "Team changes");
    await writeFile(path.join(cwd, "pending.txt"), "Not yet committed\n");
    expect(await review.pushThread(thread, project)).toEqual({ remote: "origin", branch: branch() });
    expect(await remoteHead()).toBe(committed.sha);
    expect(await head()).toBe(committed.sha);
    expect((await gitTools.git(cwd, ["status", "--porcelain"])).stdout).toContain("pending.txt");
    expect((await gitTools.git(project.rootPath, ["ls-remote", "origin", "refs/heads/main"])).stdout.trim().split(/\s/)[0]).toBe(base);
  });

  it("requires an explicit push before mocked PR creation and records the exact lead branch", async () => {
    await change();
    await review.commitThread(thread, project, "Ready for review");
    await expect(review.createThreadPr(thread, project, "Team PR", "Reviewed integrated changes", "main")).rejects.toThrow(/push/i);
    expect(gitTools.createPr).not.toHaveBeenCalled();
    expect(await remoteHead()).toBe("");
    await review.pushThread(thread, project);
    expect(await review.createThreadPr(thread, project, "Team PR", "Reviewed integrated changes", "main")).toEqual({ url: "https://example.invalid/pull/1" });
    expect(gitTools.createPr).toHaveBeenCalledWith(await realCwd(), { title: "Team PR", body: "Reviewed integrated changes", base: "main", head: branch() });
    expect(threads.get(db, thread.id)).toMatchObject({ prUrl: "https://example.invalid/pull/1", prState: "open" });
  });

  it.each(["Pending approval"])("blocks every Git side effect for %s", async (reason) => {
    await change();
    blocked = reason;
    for (const action of [() => review.commitThread(thread, project, "Blocked"), () => review.pushThread(thread, project), () => review.createThreadPr(thread, project, "Blocked", "", "main")]) {
      await expect(action()).rejects.toThrow(reason);
    }
    expect(await head()).toBe(base);
    expect(await remoteHead()).toBe("");
    expect(gitTools.hasGh).not.toHaveBeenCalled();
    expect(gitTools.createPr).not.toHaveBeenCalled();
    expect((await gitTools.git(cwd, ["diff", "--cached", "--name-only"])).stdout).toBe("");
  });

  it("holds both the team reservation and workspace writer through awaited PR preparation", async () => {
    await change();
    await review.commitThread(thread, project, "Ready");
    await review.pushThread(thread, project);
    const held = deferred();
    vi.mocked(gitTools.hasGh).mockImplementationOnce(async () => {
      await held.promise;
      return true;
    });
    const pending = review.createThreadPr(thread, project, "Held", "", "main");
    await vi.waitFor(() => expect(gitTools.hasGh).toHaveBeenCalled());
    expect(reserved).toBe(true);
    await expect(writers.acquire(cwd, "new provider turn")).rejects.toThrow(/in use/);
    await expect(review.commitThread(thread, project, "Concurrent")).rejects.toThrow(/operation/);
    blocked = "Changed while awaiting GitHub readiness";
    held.resolve();
    await expect(pending).rejects.toThrow(/Changed while awaiting/);
    expect(gitTools.createPr).not.toHaveBeenCalled();
    expect(reserved).toBe(false);
    const lease = await writers.acquire(cwd, "after failure");
    lease.release();
  });

  it("rejects a divergent dedicated ref before staging or committing", async () => {
    await change();
    const unrelated = (await gitTools.git(cwd, ["commit-tree", `${base}^{tree}`, "-m", "Unrelated history"])).stdout.trim();
    await gitTools.git(cwd, ["update-ref", `refs/heads/${branch()}`, unrelated]);
    await expect(review.commitThread(thread, project, "Must not overwrite")).rejects.toThrow(/divergent/);
    expect(await head()).toBe(base);
    expect((await gitTools.git(cwd, ["diff", "--cached", "--name-only"])).stdout).toBe("");
    expect((await gitTools.git(cwd, ["rev-parse", `refs/heads/${branch()}`])).stdout.trim()).toBe(unrelated);
  });

  it("preserves a completed commit when CAS catches an external publication ref change", async () => {
    await change();
    const commit = gitTools.commitAll;
    const unrelated = (await gitTools.git(cwd, ["commit-tree", `${base}^{tree}`, "-m", "Concurrent branch"])).stdout.trim();
    vi.spyOn(gitTools, "commitAll").mockImplementationOnce(async (root, message) => {
      const sha = await commit(root, message);
      await gitTools.git(root, ["update-ref", `refs/heads/${branch()}`, unrelated]);
      return sha;
    });
    await expect(review.commitThread(thread, project, "Retained commit")).rejects.toThrow(/Commit .* was created.*could not advance/);
    expect(await head()).not.toBe(base);
    expect((await gitTools.git(cwd, ["show", "HEAD:team.txt"])).stdout).toBe("Combined team result\n");
    expect((await gitTools.git(cwd, ["rev-parse", `refs/heads/${branch()}`])).stdout.trim()).toBe(unrelated);
    expect(await remoteHead()).toBe("");
    expect(reserved).toBe(false);
  });

  it("refuses to advance a dedicated ref checked out elsewhere", async () => {
    await change();
    await gitTools.git(cwd, ["branch", branch(), base]);
    await gitTools.git(project.rootPath, ["worktree", "add", path.join(directory, "checked-out"), branch()]);
    await expect(review.commitThread(thread, project, "Blocked branch")).rejects.toThrow(/checked out/);
    expect(await head()).toBe(base);
  });

  it("requires a retained ready lead workspace and never falls back to the project branch", async () => {
    const record = teamWorkspaces.get(db, execution.id, "lead")!;
    teamWorkspaces.save(db, { ...record, state: "attention", error: "Needs recovery" });
    await expect(review.pushThread(thread, project)).rejects.toThrow(/ready integrated/);
    expect(await remoteHead()).toBe("");
    expect(reserved).toBe(false);
  });

  it("publishes a team assignment on its own dedicated branch with CAS, push-before-PR and export fences", async () => {
    const worker = path.join(directory, "worker");
    await gitTools.git(project.rootPath, ["worktree", "add", "--detach", worker, base]);
    await writeFile(path.join(worker, "assignment.txt"), "Worker result\n");
    const task = tasks.insert(db, {
      projectId: project.id,
      threadId: thread.id,
      title: "Worker assignment",
      spec: "Implement",
      priority: "none",
      labels: [],
      workspaceMode: "worktree",
      baseRef: base,
      parentTaskId: null,
      origin: "agent",
    });
    tasks.update(db, task.id, { worktreePath: worker, baseSha: base });
    const branch = `openorc/team-task-${task.id}`;
    let exportReason: string | null = null;
    const taskExport = (taskId: string) => (taskId === task.id ? { allowed: !exportReason, reason: exportReason, branch } : null);
    review = new ReviewService(db, writers, guard, { dataDir: path.join(directory, "data"), taskExport });
    exportReason = "Wait for this assignment's current turn and writers to finish first.";
    await expect(review.commit(tasks.get(db, task.id)!, project, "Blocked")).rejects.toThrow(/current turn/);
    exportReason = null;
    const committed = await review.commit(tasks.get(db, task.id)!, project, "Worker result");
    expect((await gitTools.git(worker, ["rev-parse", `refs/heads/${branch}`])).stdout.trim()).toBe(committed.sha);
    expect((await gitTools.git(worker, ["symbolic-ref", "-q", "HEAD"], { okCodes: [0, 1] })).code).toBe(1);
    expect(tasks.get(db, task.id)?.branch).toBe(branch);
    expect(threads.get(db, thread.id)?.branch).toBeNull();
    await expect(gitTools.git(project.rootPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then((r) => r.stdout.trim())).resolves.toBe(committed.sha);
    await expect(review.createPr(tasks.get(db, task.id)!, project, "Worker PR", "body", "main")).rejects.toThrow(/Push the assignment/);
    const pushed = await review.push(tasks.get(db, task.id)!, project);
    expect(pushed).toEqual({ remote: "origin", branch });
    expect((await gitTools.git(project.rootPath, ["ls-remote", "origin", `refs/heads/${branch}`])).stdout.trim().split(/\s/)[0]).toBe(committed.sha);
    const created = vi.mocked(gitTools.createPr);
    await review.createPr(tasks.get(db, task.id)!, project, "Worker PR", "body", "main");
    expect(created.mock.lastCall?.[1]).toEqual({ title: "Worker PR", body: "body", base: "main", head: branch });
    expect(await realpath(created.mock.lastCall![0])).toBe(await realpath(worker));
    // A divergent dedicated ref is never overwritten.
    await gitTools.git(project.rootPath, ["update-ref", `refs/heads/${branch}`, base]);
    await gitTools
      .git(project.rootPath, ["commit-tree", `${base}^{tree}`, "-p", base, "-m", "elsewhere"])
      .then((r) => gitTools.git(project.rootPath, ["update-ref", `refs/heads/${branch}`, r.stdout.trim()]));
    await writeFile(path.join(worker, "assignment.txt"), "Second result\n");
    await expect(review.commit(tasks.get(db, task.id)!, project, "Second")).rejects.toThrow(/divergent/);
    expect((await gitTools.git(worker, ["status", "--porcelain"])).stdout).toContain("assignment.txt");
    const exported = await review.exportPatch(tasks.get(db, task.id)!, project);
    const patch = await readFile(exported.path, "utf8");
    expect(patch).toContain("+Second result");
    expect(exported.files).toBe(1);
    expect((await gitTools.git(worker, ["for-each-ref", "refs/openorc/exports/"])).stdout.trim()).toBe("");
  });

  it("keeps assignment Git actions directed to the main team conversation", async () => {
    const task = tasks.insert(db, {
      projectId: project.id,
      threadId: thread.id,
      title: "Worker",
      spec: "Work",
      priority: "none",
      labels: [],
      workspaceMode: "worktree",
      baseRef: "main",
      parentTaskId: null,
    });
    for (const action of [() => review.commit(task, project, "Worker commit"), () => review.push(task, project), () => review.createPr(task, project, "Worker PR", "", "main")])
      await expect(action()).rejects.toThrow(/main team conversation/);
    expect(gitTools.createPr).not.toHaveBeenCalled();
  });

  it("preserves ordinary checked-out thread commit and push behavior", async () => {
    const solo = threads.insert(db, { projectId: project.id, title: "Solo", ...settings, mode: "act", permissionMode: "trusted", workspaceMode: "current" });
    await writeFile(path.join(project.rootPath, "solo.txt"), "Solo change\n");
    const committed = await review.commitThread(solo, project, "Solo result");
    expect(await review.pushThread(solo, project)).toEqual({ remote: "origin", branch: "main" });
    expect(await head(project.rootPath)).toBe(committed.sha);
    expect(reserved).toBe(false);
  });
});

async function realCwd() {
  return (await gitTools.git(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
}
