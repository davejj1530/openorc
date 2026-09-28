import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Db, orchestration, projects, runs, tasks, teamRuntime, threads } from "@openorc/db";
import { DEFAULT_TEAM_LIMITS, type TeamActorRecord, type TeamExecutionRecord } from "@openorc/protocol";
import type { PendingApproval } from "./runs.js";
import { TeamNotificationService } from "./team-notifications.js";

const opened: Db[] = [];
afterEach(() => opened.splice(0).forEach((db) => db.close()));
function fixture() {
  const db = Db.memory();
  opened.push(db);
  const settings = { agent: "codex" as const, model: "fixture", effort: null, fastMode: false };
  const project = projects.insert(db, { name: "Notify", rootPath: `/tmp/${randomUUID()}`, gitRemote: null, defaultBranch: "main", settings: {} });
  const thread = threads.insert(db, { projectId: project.id, title: "Root conversation", ...settings, mode: "act", permissionMode: "trusted" });
  const team = orchestration.save(db, {
    projectId: project.id,
    expectedRevisionId: null,
    draft: {
      name: "Team",
      limits: DEFAULT_TEAM_LIMITS,
      discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
      members: [
        { key: "lead", name: "Lead", managerKey: null, responsibility: "Coordinate", settings },
        { key: "one", name: "Engineer", managerKey: "lead", responsibility: "Build", settings },
        { key: "two", name: "Reviewer", managerKey: "lead", responsibility: "Review", settings },
      ],
    },
  });
  const instance = orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: team.revision.id });
  const actor = (id: string, taskId: string | null): TeamActorRecord => ({
    id,
    memberKey: taskId ? id : "lead",
    taskId,
    parentId: taskId ? "lead" : null,
    requestKey: taskId ? id : null,
    requestHash: taskId ? id : null,
    dependencies: [],
    input: { title: "Assigned work", spec: "Work", responsibility: "Work", attachments: [], settings },
    state: "queued",
    retries: 0,
    directionVersion: 0,
    deliveredVersion: 0,
    disposition: null,
    result: null,
    snapshotId: null,
    error: null,
  });
  const record = teamRuntime.create(db, {
    id: randomUUID(),
    instanceId: instance.id,
    projectId: project.id,
    threadId: thread.id,
    state: "active",
    generation: 1,
    revision: 0,
    limits: DEFAULT_TEAM_LIMITS,
    actors: [actor("lead", null)],
    attempts: [],
    messages: [],
    error: null,
    createdAt: 1,
    updatedAt: 1,
    deadlineAt: 1_000_000,
  });
  const notify = vi.fn();
  const pending: PendingApproval[] = [];
  const service = new TeamNotificationService(db, { pending: () => pending }, notify);
  service.baselineAfterRecovery();
  const update = (change: (record: TeamExecutionRecord) => void) => teamRuntime.update(db, record.id, change).record;
  const addWorker = (id: string) =>
    update((current) => {
      const task = tasks.insert(db, { projectId: project.id, threadId: thread.id, title: id, spec: "Work", priority: "none", labels: [], workspaceMode: "current", baseRef: null, parentTaskId: null });
      current.actors.push(actor(id, task.id));
    });
  const start = (actorId: string) =>
    update((current) => {
      const owner = current.actors.find((item) => item.id === actorId)!;
      const run = runs.insert(db, { id: randomUUID(), taskId: owner.taskId, threadId: owner.taskId ? null : thread.id, ...settings, mode: "act", permissionMode: "trusted" });
      owner.state = "running";
      current.attempts.push({
        id: randomUUID(),
        actorId,
        runId: run.id,
        generation: current.generation,
        state: "running",
        settings,
        configurationVersion: 1,
        directionVersion: 0,
        messageIds: [],
        createdAt: 2,
        endedAt: null,
        snapshotId: null,
        error: null,
      });
    });
  return { db, thread, record, notify, service, pending, update, addWorker, start };
}
describe("aggregate team notifications", () => {
  it("coalesces new attention causes, stays silent as causes resolve, and alerts on a new failed attempt", () => {
    const f = fixture();
    f.addWorker("one");
    f.addWorker("two");
    f.start("one");
    f.start("two");
    const fail = (record: TeamExecutionRecord) => {
      record.state = "attention";
      for (const actor of record.actors.filter((item) => item.taskId)) {
        actor.state = "attention";
        actor.error = "Needs recovery";
      }
      for (const attempt of record.attempts) {
        attempt.state = "closed";
        attempt.endedAt = 3;
        attempt.error = "failed";
      }
    };
    f.service.observe(f.update(fail));
    f.service.observe(teamRuntime.get(f.db, f.record.id)!);
    expect(f.notify).toHaveBeenCalledTimes(1);
    f.service.observe(
      f.update((record) => {
        record.actors.find((actor) => actor.id === "one")!.state = "queued";
      }),
    );
    expect(f.notify).toHaveBeenCalledTimes(1);
    f.start("one");
    f.service.observe(f.update(fail));
    expect(f.notify).toHaveBeenCalledTimes(2);
    expect(f.notify.mock.lastCall![0]).toMatchObject({ actorId: "one", body: expect.stringContaining("Engineer needs attention") });
  });
  it("baselines recovered attention and suppresses shutdown and preference catch-up", () => {
    const f = fixture();
    f.service.shutdown();
    const attention = f.update((record) => {
      record.state = "attention";
      record.generation++;
      record.actors[0]!.state = "attention";
      record.actors[0]!.error = "Restarted";
    });
    f.service.observe(attention);
    f.service.baselineAfterRecovery();
    f.service.observe(attention);
    expect(f.notify).not.toHaveBeenCalled();
    let enabled = false;
    const filtered = new TeamNotificationService(f.db, { pending: () => [] }, (notice) => {
      if (enabled) f.notify(notice);
    });
    filtered.baselineAfterRecovery();
    const complete = f.update((record) => {
      record.state = "completed";
      record.actors[0]!.state = "completed";
    });
    filtered.observe(complete);
    enabled = true;
    filtered.observe(complete);
    expect(f.notify).not.toHaveBeenCalled();
  });
  it("keeps identical approval IDs distinct by run, preserves questions, and rejects stale/nonpending requests", () => {
    const f = fixture();
    f.addWorker("one");
    f.addWorker("two");
    f.start("one");
    const record = f.start("two");
    for (const [index, attempt] of record.attempts.entries()) {
      const actor = record.actors.find((item) => item.id === attempt.actorId)!;
      f.pending.push({ runId: attempt.runId!, taskId: actor.taskId, threadId: null, approvalId: "same", detail: "request" });
      const event = { type: "approval.requested" as const, runId: attempt.runId!, approvalId: "same", kind: index ? ("user_input" as const) : ("command" as const), input: {}, ts: 3 };
      f.service.approval(event);
      f.service.approval(event);
    }
    expect(f.notify.mock.calls.map((call) => call[0].kind)).toEqual(["approval", "question"]);
    expect(f.notify.mock.calls.map((call) => call[0].taskId)).toEqual(record.actors.filter((actor) => actor.taskId).map((actor) => actor.taskId));
    expect(f.pending).toHaveLength(2);
    f.service.approval({ type: "approval.requested", runId: record.attempts[0]!.runId!, approvalId: "missing", kind: "command", input: {}, ts: 4 });
    f.update((current) => {
      current.generation++;
      current.state = "stopped";
      current.actors.forEach((actor) => (actor.state = "cancelled"));
    });
    f.pending[0]!.approvalId = "late";
    f.service.approval({ type: "approval.requested", runId: record.attempts[0]!.runId!, approvalId: "late", kind: "command", input: {}, ts: 4 });
    expect(f.notify).toHaveBeenCalledTimes(2);
  });
});
