import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { audit, Db, LedgerWriter, orchestration, projects, runs as runRows, tasks, teamRuntime, teamWorkspaces, threads } from "@openorc/db";
import { run } from "@openorc/git";
import { DEFAULT_TEAM_LIMITS, type Project, type Thread } from "@openorc/protocol";
import { FrameCoalescer } from "../frames.js";
import { LifecycleService } from "./lifecycle.js";
import { RunService } from "./runs.js";
import { AppSettingsService } from "./settings.js";
import { ShellEnvironment } from "./shell-environment.js";
import { ThreadService } from "./threads.js";
import { WorkspaceService } from "./workspace.js";

vi.mock("@openorc/git", async (importOriginal) => ({ ...(await importOriginal<typeof import("@openorc/git")>()), run: vi.fn() }));

const DAY = 86_400_000;
let db: Db;
let ledger: LedgerWriter;
let project: Project;
let lifecycle: LifecycleService;
let runs: RunService;
let threadService: ThreadService;
let appSettings: AppSettingsService;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  db = Db.memory();
  ledger = new LedgerWriter(db);
  project = projects.insert(db, { name: "Lifecycle fixture", rootPath: "/unused/lifecycle-fixture", defaultBranch: "main", gitRemote: null, settings: {} });
  const environment = new ShellEnvironment({ env: { ...process.env, OPENORC_CLAUDE_BIN: "/fixture/claude", OPENORC_CODEX_BIN: "/fixture/codex" } });
  runs = new RunService(
    db,
    ledger,
    new FrameCoalescer(() => {}),
    async () => {
      throw new Error("No provider should start");
    },
    () => {},
    log,
    {
      environment: () => environment.current(),
      brief: () => "",
      onRunFinished() {},
      onThreadTurn() {},
      notify() {},
      claudeVersion: async () => null,
    },
  );
  threadService = new ThreadService(
    db,
    runs,
    new WorkspaceService(db, { dataDir: "/unused/lifecycle-data" }, log),
    () => {},
    log,
    async () => null,
  );
  appSettings = new AppSettingsService(db);
  appSettings.set({ autoDoneDays: 1, autoArchiveDoneDays: 1, autoDoneOnPrMerge: true });
  lifecycle = new LifecycleService(db, threadService, () => {}, log);
  vi.mocked(run).mockResolvedValue({ stdout: JSON.stringify({ state: "MERGED" }), stderr: "", code: 0 });
  log.warn.mockClear();
});

afterEach(async () => {
  lifecycle.stop();
  await runs.closeAll();
  ledger.close();
  db.close();
  vi.clearAllMocks();
});

function insert(title: string): Thread {
  return threads.insert(db, { projectId: project.id, title, agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted" });
}

function pin(thread: Thread, state: "waiting" | "attention" | "completed" | "stopped") {
  const settings = { agent: "codex" as const, model: "fixture", effort: null, fastMode: false };
  const saved = orchestration.save(db, {
    projectId: project.id,
    expectedRevisionId: null,
    draft: {
      name: "Managed team",
      limits: { ...DEFAULT_TEAM_LIMITS },
      discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
      members: [
        { key: "coordinator", name: "Lead", managerKey: null, responsibility: "Coordinate", settings },
        { key: "worker", name: "Worker", managerKey: "coordinator", responsibility: "Implement", settings },
      ],
    },
  });
  const instance = orchestration.getInstance(db, thread.id) ?? orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: saved.revision.id });
  const now = Date.now();
  const execution = teamRuntime.create(db, {
    id: randomUUID(),
    instanceId: instance.id,
    threadId: thread.id,
    projectId: project.id,
    state: "active",
    generation: 1,
    revision: 0,
    limits: { ...DEFAULT_TEAM_LIMITS },
    actors: [
      {
        id: "lead",
        memberKey: "coordinator",
        taskId: null,
        parentId: null,
        requestKey: null,
        requestHash: null,
        dependencies: [],
        input: { title: thread.title, spec: "Work remains", attachments: [], responsibility: "Coordinate", settings },
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
    deadlineAt: now + 60 * 60_000,
  });
  return teamRuntime.update(db, execution.id, (record) => {
    record.state = state === "waiting" ? "active" : state;
    record.actors[0]!.state = state === "stopped" ? "cancelled" : state;
    record.actors[0]!.disposition = state === "waiting" ? { kind: "wait", version: 0, result: null, waitFor: [] } : null;
    record.error = state === "attention" ? "Provider recovery required" : null;
  }).record;
}

describe("pinned team lifecycle guards", () => {
  it("keeps a PR badge through malformed process output and accepts the next valid state", async () => {
    const thread = insert("Recover the PR badge");
    threads.update(db, thread.id, { prUrl: "https://example.invalid/pull/recovery", prState: "open" });
    for (const stdout of ["not JSON", "null", "[]", '{"state":null}', '{"state":7}', '{"state":"UNKNOWN"}']) {
      vi.mocked(run).mockResolvedValueOnce({ stdout, stderr: "", code: 0 });
      await lifecycle.pollPullRequests();
      expect(threads.get(db, thread.id)?.prState).toBe("open");
    }
    await lifecycle.pollPullRequests();
    expect(threads.get(db, thread.id)?.prState).toBe("merged");
  });

  it.each(["waiting"] as const)("updates a merge badge while %s and keeps the conversation open after work finishes", async (state) => {
    appSettings.set({ autoDoneDays: null, autoArchiveDoneDays: null });
    const thread = insert("Merge while team still owns work");
    const execution = pin(thread, state);
    threads.update(db, thread.id, { prUrl: "https://example.invalid/pull/deferred", prState: "open" });
    await lifecycle.pollPullRequests();
    expect(threads.get(db, thread.id)).toMatchObject({ prState: "merged", doneAt: null });
    for (let index = 0; index < 505; index++) audit.record(db, { actor: "user", action: "thread.update", resourceType: "thread", resourceId: thread.id, metadata: { pinned: true } });
    lifecycle = new LifecycleService(db, threadService, () => {}, log);
    await lifecycle.tick();
    expect(threads.get(db, thread.id)?.doneAt).toBeNull();
    teamRuntime.update(db, execution.id, (record) => {
      record.state = "completed";
      record.actors[0]!.state = "completed";
      record.actors[0]!.disposition = null;
    });
    await lifecycle.tick();
    expect(threads.get(db, thread.id)?.doneAt).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
    threadService.update(thread.id, { done: false });
    lifecycle = new LifecycleService(db, threadService, () => {}, log);
    await lifecycle.tick();
    expect(threads.get(db, thread.id)?.doneAt).toBeNull();
    expect(db.stmt("SELECT action FROM audit_events WHERE resource_id = ? AND action LIKE 'thread.pr_merge.%' ORDER BY id").all(thread.id)).toEqual([]);
  });

  it("keeps merged conversations open through Stop and writer shutdown", async () => {
    appSettings.set({ autoDoneDays: null, autoArchiveDoneDays: null });
    const thread = insert("Merge while stopping");
    const execution = pin(thread, "waiting");
    threads.update(db, thread.id, { prUrl: "https://example.invalid/pull/stopping", prState: "open" });
    teamRuntime.update(db, execution.id, (record) => {
      record.state = "stopping";
      record.generation++;
      record.actors[0]!.state = "cancelled";
    });
    await lifecycle.pollPullRequests();
    expect(threads.get(db, thread.id)?.doneAt).toBeNull();
    teamRuntime.update(db, execution.id, (record) => {
      record.state = "stopped";
    });
    const task = tasks.insert(db, {
      projectId: project.id,
      threadId: thread.id,
      title: "Closing child",
      spec: "Retain writer",
      priority: "none",
      labels: [],
      workspaceMode: "worktree",
      baseRef: "main",
      parentTaskId: null,
    });
    const writer = runRows.insert(db, { id: randomUUID(), taskId: task.id, threadId: null, agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted" });
    const live = vi.spyOn(runs, "liveRunForTask").mockImplementation((id) => (id === task.id ? writer : null));
    await lifecycle.tick();
    expect(threads.get(db, thread.id)?.doneAt).toBeNull();
    live.mockRestore();
    const approval = runs.requestApproval(writer.id, "closing-question", "AskUserQuestion", {});
    await lifecycle.tick();
    expect(threads.get(db, thread.id)?.doneAt).toBeNull();
    runs.resolveApproval(writer.id, "closing-question", "deny");
    await approval;
    await lifecycle.tick();
    expect(threads.get(db, thread.id)?.doneAt).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each(["setting", "manual-active", "archive", "snooze", "snooze-and-reverse", "replacement"] as const)(
    "retires deferred merge completion after %s rather than undoing the later choice",
    async (choice) => {
      appSettings.set({ autoDoneDays: null, autoArchiveDoneDays: null });
      const thread = insert("Preserve manual lifecycle choice");
      const execution = pin(thread, "waiting");
      threads.update(db, thread.id, { prUrl: "https://example.invalid/pull/old", prState: "open" });
      await lifecycle.pollPullRequests();
      teamRuntime.update(db, execution.id, (record) => {
        record.state = "stopped";
        record.actors[0]!.state = "cancelled";
        record.actors[0]!.disposition = null;
      });
      if (choice === "setting") appSettings.set({ autoDoneOnPrMerge: false });
      if (choice === "manual-active") threadService.update(thread.id, { done: false });
      if (choice === "archive") threadService.update(thread.id, { archived: true });
      if (choice === "snooze") threadService.update(thread.id, { snoozedUntil: Date.now() + DAY });
      if (choice === "snooze-and-reverse") {
        threadService.update(thread.id, { snoozedUntil: Date.now() + DAY });
        threadService.update(thread.id, { snoozedUntil: null });
      }
      if (choice === "replacement") threads.update(db, thread.id, { prUrl: "https://example.invalid/pull/new", prState: "closed" });
      await lifecycle.tick();
      expect(threads.get(db, thread.id)?.doneAt).toBeNull();
      appSettings.set({ autoDoneOnPrMerge: true });
      threadService.update(thread.id, { archived: false, snoozedUntil: null });
      await lifecycle.tick();
      expect(threads.get(db, thread.id)?.doneAt).toBeNull();
      expect(run).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["setting", "manual-active", "archive", "replacement", "deleted"] as const)("rechecks %s after a PR lookup before retaining merge completion", async (change) => {
    appSettings.set({ autoDoneDays: null, autoArchiveDoneDays: null });
    const thread = insert("Lookup raced a user change");
    threads.update(db, thread.id, { prUrl: "https://example.invalid/pull/lookup", prState: "open" });
    let release!: () => void;
    vi.mocked(run).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { stdout: JSON.stringify({ state: "MERGED" }), stderr: "", code: 0 };
    });
    const polling = lifecycle.pollPullRequests();
    if (change === "setting") appSettings.set({ autoDoneOnPrMerge: false });
    if (change === "manual-active") threadService.update(thread.id, { done: false });
    if (change === "archive") threadService.update(thread.id, { archived: true });
    if (change === "replacement") threads.update(db, thread.id, { prUrl: "https://example.invalid/pull/replacement", prState: "closed" });
    if (change === "deleted") threads.delete(db, thread.id);
    release();
    await expect(polling).resolves.toBeUndefined();
    const fresh = threads.get(db, thread.id);
    if (change === "deleted") expect(fresh).toBeNull();
    else {
      expect(fresh?.doneAt).toBeNull();
      if (change === "replacement") expect(fresh).toMatchObject({ prUrl: "https://example.invalid/pull/replacement", prState: "closed" });
      appSettings.set({ autoDoneOnPrMerge: true });
      await lifecycle.tick();
      expect(threads.get(db, thread.id)?.doneAt).toBeNull();
    }
  });

  it.each(["waiting"] as const)("preserves a %s team while ordinary threads wake and refresh PR badges without completion", async (state) => {
    const old = Date.now() - 2 * DAY;
    const pinnedIdle = insert("Team still has work");
    const pinnedDone = insert("Retained team recovery");
    const pinnedPr = insert("Team with merged PR");
    const pinnedSnooze = insert("Retained team snooze");
    const pinned = [pinnedIdle, pinnedDone, pinnedPr, pinnedSnooze];
    const executions = pinned.map((thread) => pin(thread, state));
    const idle = insert("Ordinary idle thread");
    const done = insert("Ordinary done thread");
    const pr = insert("Ordinary merged PR");
    const snoozed = insert("Ordinary snooze");
    for (const thread of [pinnedIdle, idle]) db.stmt("UPDATE threads SET last_activity_at = ? WHERE id = ?").run(old, thread.id);
    for (const thread of [pinnedDone, done]) threads.update(db, thread.id, { doneAt: old });
    for (const thread of [pinnedPr, pr]) threads.update(db, thread.id, { prUrl: `https://example.invalid/pull/${thread.id}`, prState: "open" });
    for (const thread of [pinnedSnooze, snoozed]) threads.update(db, thread.id, { snoozedUntil: old });
    for (const thread of pinned) expect(runs.liveRunForThread(thread.id)).toBeNull();

    await lifecycle.tick();

    expect(threads.get(db, pinnedIdle.id)).toMatchObject({ doneAt: null, archivedAt: null });
    expect(threads.get(db, pinnedDone.id)).toMatchObject({ doneAt: old, archivedAt: null });
    expect(threads.get(db, pinnedPr.id)).toMatchObject({ prState: "merged", doneAt: null, archivedAt: null });
    expect(threads.get(db, pinnedSnooze.id)?.snoozedUntil).toBe(old);
    for (const execution of executions) expect(teamRuntime.get(db, execution.id)).toEqual(execution);
    expect(threads.get(db, idle.id)?.doneAt).toBeNull();
    expect(threads.get(db, done.id)?.archivedAt).toBeNull();
    expect(threads.get(db, pr.id)).toMatchObject({ prState: "merged", doneAt: null });
    expect(threads.get(db, snoozed.id)?.snoozedUntil).toBeNull();
    expect(run).toHaveBeenCalledTimes(2);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each(["completed"] as const)("organizes a quiescent %s team without altering execution history", async (state) => {
    const old = Date.now() - 2 * DAY;
    const idle = insert("Finished team");
    const done = insert("Done team");
    const snoozed = insert("Snoozed team");
    const pr = insert("Merged team");
    const executions = [idle, done, snoozed, pr].map((thread) => pin(thread, state));
    db.stmt("UPDATE threads SET last_activity_at = ? WHERE id = ?").run(old, idle.id);
    threads.update(db, done.id, { doneAt: old });
    threads.update(db, snoozed.id, { snoozedUntil: old });
    threads.update(db, pr.id, { prUrl: "https://example.invalid/pull/finished", prState: "open" });
    await lifecycle.tick();
    expect(threads.get(db, idle.id)?.doneAt).toBeNull();
    expect(threads.get(db, done.id)?.archivedAt).toBeNull();
    expect(threads.get(db, snoozed.id)?.snoozedUntil).toBeNull();
    expect(threads.get(db, pr.id)).toMatchObject({ prState: "merged", doneAt: null });
    for (const execution of executions) expect(teamRuntime.get(db, execution.id)).toEqual(execution);
  });

  it.each(["attention"] as const)("rejects organization changes atomically while the team is %s", (state) => {
    const thread = insert("Keep this exact draft");
    pin(thread, state);
    for (const patch of [{ done: true }, { done: false }, { archived: true }, { archived: false }, { snoozedUntil: Date.now() + DAY }, { snoozedUntil: null }]) {
      expect(() => threadService.update(thread.id, { title: "Should not save", draft: "Should not save", mode: "plan", ...patch })).toThrow(/unfinished execution/);
      expect(threads.get(db, thread.id)).toEqual(thread);
    }
  });

  it("does not finish a team admitted during an asynchronous PR lookup", async () => {
    const thread = insert("PR lookup racing new work");
    pin(thread, "completed");
    threads.update(db, thread.id, { prUrl: "https://example.invalid/pull/race", prState: "open" });
    let release!: () => void;
    vi.mocked(run).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { stdout: JSON.stringify({ state: "MERGED" }), stderr: "", code: 0 };
    });
    const pending = lifecycle.pollPullRequests();
    expect(release).toBeTypeOf("function");
    const admitted = pin(thread, "waiting");
    release();
    await pending;
    expect(threads.get(db, thread.id)).toMatchObject({ prState: "merged", doneAt: null });
    expect(teamRuntime.get(db, admitted.id)).toEqual(admitted);
  });

  it("keeps a terminal team visible while a descendant writer or approval remains", async () => {
    const thread = insert("Retained descendant");
    pin(thread, "stopped");
    const task = tasks.insert(db, {
      projectId: project.id,
      threadId: thread.id,
      title: "Retained task",
      spec: "Keep this work",
      priority: "none",
      labels: [],
      workspaceMode: "worktree",
      baseRef: "main",
      parentTaskId: null,
    });
    const run = runRows.insert(db, { id: randomUUID(), taskId: task.id, threadId: null, agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted" });
    const live = vi.spyOn(runs, "liveRunForTask").mockImplementation((id) => (id === task.id ? run : null));
    try {
      expect(() => threadService.update(thread.id, { archived: true })).toThrow(/writer/);
    } finally {
      live.mockRestore();
    }
    const approval = runs.requestApproval(run.id, "retained-question", "AskUserQuestion", {});
    expect(() => threadService.update(thread.id, { done: true })).toThrow(/pending requests/);
    runs.resolveApproval(run.id, "retained-question", "deny");
    await approval;
    expect(threadService.update(thread.id, { done: true }).doneAt).toBeNull();
  });

  it("keeps retained publication recovery visible until its receipt is applied", async () => {
    const thread = insert("Interrupted publication");
    const execution = pin(thread, "waiting");
    const task = tasks.insert(db, {
      projectId: project.id,
      threadId: thread.id,
      title: "Completed child",
      spec: "Retained child output",
      priority: "none",
      labels: [],
      workspaceMode: "worktree",
      baseRef: "main",
      parentTaskId: null,
    });
    teamRuntime.update(db, execution.id, (record) => {
      record.actors.push({
        ...record.actors[0]!,
        id: "child",
        memberKey: "worker",
        taskId: task.id,
        parentId: "lead",
        requestKey: "child",
        requestHash: "child",
        state: "completed",
        disposition: null,
      });
      record.actors[0]!.state = "cancelled";
      record.state = "stopped";
    });
    const sha = "a".repeat(40);
    const now = Date.now();
    const source = { rootPath: "/retained/source", headSha: sha, branch: "main", treeSha: sha, treeRef: "refs/retained/tree", headRef: "refs/retained/head", indexSha256: null };
    for (const actor of teamRuntime.get(db, execution.id)!.actors)
      teamWorkspaces.save(db, {
        id: randomUUID(),
        executionId: execution.id,
        actorId: actor.id,
        taskId: actor.taskId,
        parentActorId: actor.parentId,
        path: `/retained/${actor.id}`,
        source,
        state: "ready",
        setupState: "completed",
        preparedTree: sha,
        outputTree: sha,
        error: null,
        createdAt: now,
        updatedAt: now,
      });
    const publication = teamWorkspaces.savePublication(db, {
      id: randomUUID(),
      executionId: execution.id,
      sourceActorId: "child",
      targetActorId: "lead",
      outputTree: sha,
      destinationPath: "/retained/lead",
      before: source,
      afterTree: sha,
      scratchPath: "/retained/scratch",
      state: "attention",
      entries: [],
      includedActorIds: ["child"],
      error: "Publication interrupted",
      createdAt: now,
      updatedAt: now,
    });
    const old = Date.now() - 2 * DAY;
    threads.update(db, thread.id, { doneAt: old, snoozedUntil: old });
    expect(() => threadService.update(thread.id, { archived: true })).toThrow(/retained publication/);
    await lifecycle.tick();
    expect(threads.get(db, thread.id)).toMatchObject({ archivedAt: null, snoozedUntil: old });
    expect(teamWorkspaces.publication(db, publication.id)).toEqual(publication);
    teamWorkspaces.savePublication(db, { ...publication, state: "applied", error: null });
    await lifecycle.tick();
    expect(threads.get(db, thread.id)).toMatchObject({ archivedAt: null, snoozedUntil: null });
  });
});
