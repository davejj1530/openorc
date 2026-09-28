import { insertLegacyRun } from "./fixtures/legacy-run.js";
import { legacyTeamRuntime, readLegacyJournals, teamJournalWriter } from "./fixtures/legacy-team-journal.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { TeamTaskCompletionIntent, type TeamAttemptRecord } from "@openorc/protocol";
import { Db } from "./database.js";
import { orchestration } from "./orchestration.js";
import { checkpoints } from "./checkpoints.js";
import { projects, runs, snapshots, tasks, threads } from "./repos.js";
import { migrations } from "./schema.js";
import { teamRuntime } from "./team-runtime.js";
import { teamTasks } from "./team-tasks.js";
import { teamTaskCompletions } from "./team-task-completions.js";

const opened = new Set<Db>();
const folders: string[] = [];
afterEach(() => {
  for (const db of opened) db.close();
  opened.clear();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const settings = { agent: "codex" as const, model: "fixture", effort: null, fastMode: false };
const stat = { files: 1, insertions: 1, deletions: 0, untracked: 0 };
function fixture(db = Db.memory(), message = false) {
  opened.add(db);
  const project = projects.insert(db, { name: "Lead completion", rootPath: `/tmp/completion-${randomUUID()}`, defaultBranch: "main", gitRemote: null, settings: {} });
  const thread = threads.insert(db, { projectId: project.id, title: "Lead work", ...settings, mode: "act", permissionMode: "trusted" });
  const saved = orchestration.save(db, {
    projectId: project.id,
    expectedRevisionId: null,
    draft: {
      name: "Lead only",
      members: [{ key: "root", name: "Lead", responsibility: "Complete work", managerKey: null, settings }],
      limits: { maxConcurrentAgents: 1, maxAssignments: 12, maxExecutionMinutes: 60, maxAttemptsPerAssignment: 3 },
    },
  });
  const instance = orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: saved.revision.id });
  const task = tasks.insert(db, {
    projectId: project.id,
    threadId: thread.id,
    title: "Real backlog task",
    spec: "Complete the requested change",
    priority: "none",
    labels: [],
    workspaceMode: "worktree",
    baseRef: "main",
    parentTaskId: null,
  });
  teamTasks.createIntent(db, {
    taskId: task.id,
    instanceId: instance.id,
    teamRevisionId: saved.revision.id,
    managerKey: "root",
    memberKey: null,
    parentTaskId: null,
    dependencyTaskIds: [],
    origin: null,
    capture: null,
    createdAt: 10,
  });
  const admission = teamTasks.createAdmission(db, {
    id: randomUUID(),
    taskId: task.id,
    instanceId: instance.id,
    requestKey: "start",
    payloadHash: "a".repeat(64),
    kind: "start",
    input: { title: task.title, spec: task.spec!, attachments: [] },
    source: null,
    sourceAdmissionId: null,
    reviewBatchId: null,
    createdAt: 20,
  });
  const execution = teamJournalWriter(db).create(db, {
    id: randomUUID(),
    instanceId: instance.id,
    projectId: project.id,
    threadId: thread.id,
    state: "active",
    generation: 1,
    revision: 0,
    limits: saved.revision.limits,
    actors: [
      {
        id: "lead",
        memberKey: "root",
        taskId: null,
        parentId: null,
        requestKey: null,
        requestHash: null,
        dependencies: [],
        input: { title: thread.title, spec: "Work on task", attachments: [], responsibility: "Complete work", settings },
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
    createdAt: 30,
    updatedAt: 30,
    deadlineAt: 3600030,
  });
  if (message)
    teamJournalWriter(db).update(db, execution.id, (record) => {
      record.messages.push({
        id: "task-direction",
        senderId: "user",
        recipientId: "lead",
        sequence: 1,
        kind: "direction",
        body: "Take this task",
        dedupeKey: "direction:user:task",
        state: "pending",
        attemptId: null,
        createdAt: 40,
        deliveredAt: null,
      });
    });
  teamTasks.appendRoute(db, { admissionId: admission.id, executionId: execution.id, actorId: "lead", sequence: 1, messageId: message ? "task-direction" : null, role: "assignee", createdAt: 50 });
  const run = insertLegacyRun(db, { id: randomUUID(), taskId: null, threadId: thread.id, ...settings, mode: "act", permissionMode: "trusted" });
  const attempt: TeamAttemptRecord = {
    id: randomUUID(),
    actorId: "lead",
    runId: run.id,
    generation: 1,
    state: "running",
    settings,
    configurationVersion: 1,
    directionVersion: 0,
    messageIds: [],
    resumeSessionId: null,
    snapshotId: null,
    error: null,
    createdAt: 60,
    endedAt: null,
  };
  teamJournalWriter(db).update(db, execution.id, (record) => {
    record.attempts.push(attempt);
    record.actors[0]!.state = "running";
  });
  const intent: TeamTaskCompletionIntent = { admissionId: admission.id, executionId: execution.id, actorId: "lead", attemptId: attempt.id, result: "Implemented the requested change.", createdAt: 70 };
  return { db, project, thread, instance, task, admission, execution, run, attempt, intent };
}
function finish(f: ReturnType<typeof fixture>) {
  const checkpoint = checkpoints.insert(f.db, { threadId: f.thread.id, runId: f.run.id, turn: 1, treeSha: "a".repeat(40), diffStat: stat });
  const snapshot = snapshots.insert(f.db, { taskId: f.task.id, runId: f.run.id, turn: 1, treeSha: checkpoint.treeSha, diffStat: stat });
  runs.update(f.db, f.run.id, { state: "success", endedAt: 80 });
  teamRuntime.update(f.db, f.execution.id, (record) => {
    const attempt = record.attempts.find((item) => item.id === f.attempt.id)!;
    attempt.state = "closed";
    attempt.endedAt = 80;
    attempt.snapshotId = checkpoint.id;
    record.actors[0]!.state = "completed";
    record.state = "completed";
    for (const message of record.messages)
      if (message.attemptId === attempt.id) {
        message.state = "delivered";
        message.deliveredAt = 80;
      }
  });
  return { ...f.intent, runId: f.run.id, snapshotId: snapshot.id, createdAt: 90 };
}

describe("durable lead task completion receipts", () => {
  it("retains intent and captured task success, replaying exact requests after terminal state", () => {
    const f = fixture();
    expect(teamTaskCompletions.request(f.db, f.intent)).toEqual(f.intent);
    expect(teamTaskCompletions.intentsForAttempt(f.db, f.execution.id, f.attempt.id)).toEqual([f.intent]);
    const completion = finish(f);
    expect(teamTaskCompletions.complete(f.db, completion)).toEqual(completion);
    expect(teamTaskCompletions.request(f.db, f.intent)).toEqual(f.intent);
    expect(teamTaskCompletions.complete(f.db, completion)).toEqual(completion);
    expect(teamTaskCompletions.get(f.db, f.admission.id)).toEqual(completion);
    expect(teamRuntime.get(f.db, f.execution.id)?.actors[0]?.taskId).toBeNull();
    expect(tasks.list(f.db)).toHaveLength(1);
    expect(() => teamTaskCompletions.request(f.db, { ...f.intent, result: "Changed result" })).toThrow(/different/);
    expect(() => teamTaskCompletions.complete(f.db, { ...completion, createdAt: 91 })).toThrow(/different/);
  });

  it("requires a claimed task direction and allows later attempts to use an earlier delivered direction", () => {
    const f = fixture(undefined, true);
    expect(() => teamTaskCompletions.request(f.db, f.intent)).toThrow(/claimed/);
    // A later reservation includes the task direction; immutable claims cannot
    // be retrofitted onto an already running attempt.
    teamRuntime.update(f.db, f.execution.id, (record) => {
      record.attempts[0]!.state = "closed";
      record.attempts[0]!.endedAt = 65;
      const next = { ...f.attempt, id: randomUUID(), runId: null, messageIds: ["task-direction"], createdAt: 66 };
      record.attempts.push(next);
      record.messages[0]!.state = "claimed";
      record.messages[0]!.attemptId = next.id;
      f.attempt = next;
    });
    const nextRun = runs.insert(f.db, { id: randomUUID(), taskId: null, threadId: f.thread.id, ...settings, mode: "act", permissionMode: "trusted" });
    teamRuntime.update(f.db, f.execution.id, (record) => {
      record.attempts.at(-1)!.runId = nextRun.id;
    });
    f.run = nextRun;
    f.intent = { ...f.intent, attemptId: f.attempt.id };
    expect(teamTaskCompletions.request(f.db, f.intent)).toEqual(f.intent);
    teamRuntime.update(f.db, f.execution.id, (record) => {
      record.attempts.at(-1)!.state = "closed";
      record.attempts.at(-1)!.endedAt = 75;
      record.messages[0]!.state = "delivered";
      record.messages[0]!.deliveredAt = 75;
      const next = { ...f.attempt, id: randomUUID(), runId: null, messageIds: [], createdAt: 76 };
      record.attempts.push(next);
      f.attempt = next;
    });
    const finalRun = runs.insert(f.db, { id: randomUUID(), taskId: null, threadId: f.thread.id, ...settings, mode: "act", permissionMode: "trusted" });
    teamRuntime.update(f.db, f.execution.id, (record) => {
      record.attempts.at(-1)!.runId = finalRun.id;
    });
    f.run = finalRun;
    f.intent = { ...f.intent, attemptId: f.attempt.id, createdAt: 77 };
    expect(teamTaskCompletions.request(f.db, f.intent)).toEqual(f.intent);
    expect(teamTaskCompletions.complete(f.db, finish(f)).attemptId).toBe(f.attempt.id);
  });

  it("rejects foreign admission, execution, actor, attempt and stale generation", () => {
    const f = fixture();
    const other = fixture(f.db);
    for (const change of [{ admissionId: other.admission.id }, { executionId: other.execution.id }, { attemptId: other.attempt.id }]) {
      expect(() => teamTaskCompletions.request(f.db, { ...f.intent, ...change })).toThrow();
    }
    expect(() => TeamTaskCompletionIntent.parse({ ...f.intent, actorId: "worker" })).toThrow();
    const managerOnly = teamTasks.createAdmission(f.db, { ...f.admission, id: randomUUID(), requestKey: "manager-only" });
    teamTasks.appendRoute(f.db, { admissionId: managerOnly.id, executionId: f.execution.id, actorId: "lead", sequence: 1, messageId: null, role: "manager", createdAt: 50 });
    expect(() => teamTaskCompletions.request(f.db, { ...f.intent, admissionId: managerOnly.id })).toThrow(/assignee route/);
    teamRuntime.update(f.db, f.execution.id, (record) => {
      record.generation++;
    });
    expect(() => teamTaskCompletions.request(f.db, f.intent)).toThrow(/current/);
    expect(teamTaskCompletions.intent(f.db, f.admission.id, f.attempt.id)).toBeNull();
  });

  it("rejects unclaimed late null routes and closed attempts for new requests", () => {
    const f = fixture();
    const later = teamTasks.createAdmission(f.db, { ...f.admission, id: randomUUID(), requestKey: "late" });
    for (const createdAt of [f.attempt.createdAt, 65])
      expect(() => teamTasks.appendRoute(f.db, { admissionId: later.id, executionId: f.execution.id, actorId: "lead", sequence: 1, messageId: null, role: "assignee", createdAt })).toThrow(
        /requires queued direction/,
      );
    finish(f);
    expect(() => teamTaskCompletions.request(f.db, f.intent)).toThrow(/current/);
  });

  it("requires an earlier exact intent, closed successful run and task snapshot from that run", () => {
    const f = fixture();
    const other = fixture(f.db);
    const snap = snapshots.insert(f.db, { taskId: f.task.id, runId: f.run.id, turn: 1, treeSha: "a".repeat(40), diffStat: stat });
    const early = { ...f.intent, runId: f.run.id, snapshotId: snap.id, createdAt: 90 };
    expect(() => teamTaskCompletions.complete(f.db, early)).toThrow(/earlier intent/);
    teamTaskCompletions.request(f.db, f.intent);
    expect(() => teamTaskCompletions.complete(f.db, early)).toThrow(/closed successful/);
    const completion = finish(f);
    const foreignTask = snapshots.insert(f.db, { taskId: other.task.id, runId: f.run.id, turn: 1, treeSha: "a".repeat(40), diffStat: stat });
    const foreignRun = snapshots.insert(f.db, { taskId: f.task.id, runId: other.run.id, turn: 1, treeSha: "a".repeat(40), diffStat: stat });
    for (const change of [{ result: "Not requested" }, { runId: other.run.id }, { snapshotId: foreignTask.id }, { snapshotId: foreignRun.id }])
      expect(() => teamTaskCompletions.complete(f.db, { ...completion, ...change })).toThrow();
    runs.update(f.db, f.run.id, { state: "error" });
    expect(() => teamTaskCompletions.complete(f.db, completion)).toThrow(/closed successful/);
    runs.update(f.db, f.run.id, { state: "success" });
    expect(teamTaskCompletions.complete(f.db, completion)).toEqual(completion);
  });

  it("retains a failed intent for replay after claims are returned without reporting success", () => {
    const f = fixture();
    teamTaskCompletions.request(f.db, f.intent);
    teamRuntime.update(f.db, f.execution.id, (record) => {
      record.state = "attention";
      record.actors[0]!.state = "attention";
      record.attempts[0]!.state = "attention";
      record.attempts[0]!.error = "Provider failed";
      record.attempts[0]!.endedAt = 80;
    });
    expect(teamTaskCompletions.request(f.db, f.intent)).toEqual(f.intent);
    expect(teamTaskCompletions.get(f.db, f.admission.id)).toBeNull();
    expect(teamTaskCompletions.intentsForAttempt(f.db, f.execution.id, f.attempt.id)).toEqual([f.intent]);
  });

  it("migrates existing admissions and preserves completed receipts across reopening", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "team-completion-migration-"));
    folders.push(dir);
    const file = path.join(dir, "ledger.sqlite"),
      raw = new DatabaseSync(file);
    for (const migration of migrations.slice(0, 13)) typeof migration === "string" ? raw.exec(migration) : migration(raw);
    raw.exec("PRAGMA user_version = 13");
    const restore = readLegacyJournals();
    const old = fixture(new Db(raw));
    const original = legacyTeamRuntime.get(old.db, old.execution.id);
    restore();
    old.db.close();
    opened.delete(old.db);
    let db = Db.open(file);
    opened.add(db);
    expect(teamRuntime.get(db, old.execution.id)).toEqual(original);
    expect(teamTasks.admission(db, old.admission.id)).toEqual(old.admission);
    const f = { ...old, db };
    teamTaskCompletions.request(db, f.intent);
    const completed = teamTaskCompletions.complete(db, finish(f));
    db.close();
    opened.delete(db);
    db = Db.open(file);
    opened.add(db);
    expect(teamTaskCompletions.get(db, f.admission.id)).toEqual(completed);
    expect(teamTaskCompletions.intent(db, f.admission.id, f.attempt.id)).toEqual(f.intent);
    expect(db.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
