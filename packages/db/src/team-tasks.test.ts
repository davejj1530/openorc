import { insertLegacyRun } from "./fixtures/legacy-run.js";
import { LEGACY_TEAM_PROMPT, legacyTeamRuntime, teamJournalWriter } from "./fixtures/legacy-team-journal.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  teamReviewComment,
  type ReviewComment,
  type TeamActorRecord,
  type TeamDraft,
  type TeamExecutionRecord,
  type TeamReviewBatch,
  type TeamTaskAdmission,
  type TeamTaskAdmissionRoute,
  type TeamTaskIntent,
} from "@openorc/protocol";
import { Db } from "./database.js";
import { orchestration } from "./orchestration.js";
import { comments, projects, runs, snapshots, tasks, threads } from "./repos.js";
import { migrations } from "./schema.js";
import { teamRuntime } from "./team-runtime.js";
import { teamTasks } from "./team-tasks.js";

const opened = new Set<Db>();
const folders: string[] = [];
afterEach(() => {
  for (const db of opened) db.close();
  opened.clear();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
function close(db: Db) {
  db.close();
  opened.delete(db);
}
const settings = { agent: "codex" as const, model: "fixture-model", effort: "high", fastMode: false };
const hash = "a".repeat(64);
const draft: TeamDraft = {
  name: "Task admission team",
  limits: { maxConcurrentAgents: 3, maxAssignments: 12, maxExecutionMinutes: 60, maxAttemptsPerAssignment: 3 },
  members: [
    { key: "root", name: "Lead", managerKey: null, responsibility: "Coordinate", settings },
    { key: "worker", name: "Worker", managerKey: "root", responsibility: "Implement", settings },
    { key: "peer", name: "Peer", managerKey: "root", responsibility: "Review", settings },
    { key: "manager", name: "Manager", managerKey: "root", responsibility: "Manage", settings },
    { key: "nested", name: "Nested", managerKey: "manager", responsibility: "Implement nested", settings },
  ],
};
function fixture(db = Db.memory()) {
  opened.add(db);
  const project = projects.insert(db, { name: "Task fixture", rootPath: `/tmp/task-${randomUUID()}`, defaultBranch: "main", gitRemote: null, settings: {} });
  const thread = threads.insert(db, { projectId: project.id, title: "Team tasks", ...settings, mode: "act", permissionMode: "trusted" });
  const saved = orchestration.save(db, { projectId: project.id, expectedRevisionId: null, draft });
  const instance = orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: saved.revision.id });
  const addTask = (title: string, parentTaskId: string | null = null) =>
    tasks.insert(db, {
      projectId: project.id,
      threadId: thread.id,
      title,
      spec: `Spec for ${title}`,
      priority: "none",
      labels: [],
      workspaceMode: "worktree",
      baseRef: "main",
      parentTaskId,
      origin: "agent",
    });
  const task = addTask("Worker task");
  const peer = addTask("Peer task");
  const manager = addTask("Manager task");
  const nested = addTask("Nested task", manager.id);
  const intent = (taskId = task.id, overrides: Partial<TeamTaskIntent> = {}): TeamTaskIntent => ({
    taskId,
    instanceId: instance.id,
    teamRevisionId: saved.revision.id,
    managerKey: "root",
    memberKey: "worker",
    parentTaskId: null,
    dependencyTaskIds: [],
    origin: null,
    capture: null,
    createdAt: 1000,
    ...overrides,
  });
  const admission = (overrides: Partial<TeamTaskAdmission> = {}): TeamTaskAdmission => ({
    id: randomUUID(),
    instanceId: instance.id,
    taskId: task.id,
    requestKey: randomUUID(),
    payloadHash: hash,
    kind: "start",
    input: { title: task.title, spec: task.spec!, attachments: ["/managed/reference.png"] },
    reviewBatchId: null,
    sourceAdmissionId: null,
    source: null,
    createdAt: 2000,
    ...overrides,
  });
  const addComment = (taskId = task.id, body = "Keep the expected behavior"): ReviewComment =>
    comments.insert(db, { threadId: null, taskId, snapshotId: null, path: "src/app.ts", startLine: null, startSide: null, line: 7, side: "new", lineText: null, body });
  const batch = (selected: ReviewComment[], overrides: Partial<TeamReviewBatch> = {}): TeamReviewBatch => ({
    id: randomUUID(),
    instanceId: instance.id,
    taskId: task.id,
    comments: selected.map(teamReviewComment),
    prompt: selected.map((comment) => comment.body).join("\n"),
    createdAt: 1500,
    ...overrides,
  });
  return { db, project, thread, saved, instance, task, peer, manager, nested, addTask, intent, admission, addComment, batch };
}
function actor(id: string, memberKey: string, taskId: string | null, parentId: string | null): TeamActorRecord {
  return {
    id,
    memberKey,
    taskId,
    parentId,
    requestKey: taskId ? `request-${id}` : null,
    requestHash: taskId ? hash : null,
    dependencies: [],
    input: { title: "Retained assignment", spec: "Retained instructions", attachments: [], responsibility: "Work", settings },
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
function leadExecution(f: ReturnType<typeof fixture>): TeamExecutionRecord {
  return teamJournalWriter(f.db).create(f.db, {
    id: randomUUID(),
    instanceId: f.instance.id,
    threadId: f.thread.id,
    projectId: f.project.id,
    state: "active",
    generation: 1,
    revision: 0,
    limits: draft.limits,
    actors: [actor("lead", "root", null, null)],
    attempts: [],
    messages: [],
    error: null,
    createdAt: 1000,
    updatedAt: 1000,
    deadlineAt: 3601000,
  });
}
function execution(f: ReturnType<typeof fixture>): TeamExecutionRecord {
  const created = leadExecution(f);
  return teamJournalWriter(f.db).update(f.db, created.id, (record) => {
    record.actors.push(
      actor("worker-1", "worker", f.task.id, "lead"),
      actor("peer-1", "peer", f.peer.id, "lead"),
      actor("manager-1", "manager", f.manager.id, "lead"),
      actor("nested-1", "nested", f.nested.id, "manager-1"),
    );
  }).record;
}
function route(admission: TeamTaskAdmission, record: TeamExecutionRecord, overrides: Partial<TeamTaskAdmissionRoute> = {}): TeamTaskAdmissionRoute {
  return { admissionId: admission.id, sequence: 1, executionId: record.id, actorId: "lead", messageId: null, role: "manager", createdAt: 3000, ...overrides };
}
const rawCount = (db: Db, table: string) => Number((db.stmt(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
function deleteOwner(f: ReturnType<typeof fixture>, kind: "task" | "thread" | "instance" | "project") {
  if (kind === "task") tasks.delete(f.db, f.task.id);
  else if (kind === "thread") threads.delete(f.db, f.thread.id);
  else if (kind === "instance") f.db.stmt("DELETE FROM orchestration_team_instances WHERE id = ?").run(f.instance.id);
  else f.db.stmt("DELETE FROM projects WHERE id = ?").run(f.project.id);
}
function sourceSnapshot(f: ReturnType<typeof fixture>, record: TeamExecutionRecord) {
  const run = runs.insert(f.db, { id: randomUUID(), taskId: f.task.id, threadId: null, ...settings, mode: "act", permissionMode: "trusted" });
  teamRuntime.update(f.db, record.id, (item) => {
    item.attempts.push({
      id: randomUUID(),
      actorId: "worker-1",
      runId: run.id,
      generation: 1,
      state: "starting",
      settings,
      configurationVersion: 1,
      directionVersion: 0,
      messageIds: [],
      attachments: [],
      snapshotId: null,
      error: null,
      createdAt: 1100,
      endedAt: null,
    });
  });
  return snapshots.insert(f.db, { taskId: f.task.id, runId: run.id, turn: 1, treeSha: "a".repeat(40), diffStat: { files: 1, insertions: 1, deletions: 0, untracked: 0 } });
}

describe("durable team task input and admission", () => {
  it("retains exact admitted task and review snapshots after the source document and comments change", () => {
    const f = fixture();
    const intent = teamTasks.createIntent(f.db, f.intent());
    const selected = f.addComment();
    const batch = teamTasks.createBatch(f.db, f.batch([selected]));
    const admission = teamTasks.createAdmission(f.db, f.admission({ kind: "review", reviewBatchId: batch.id }));
    tasks.update(f.db, f.task.id, { title: "Changed title", spec: "Changed spec", labels: ["new"] });
    f.db.stmt("UPDATE review_comments SET body = ? WHERE id = ?").run("Edited later", selected.id);
    comments.remove(f.db, selected.id);
    expect(teamTasks.intent(f.db, f.task.id)).toEqual(intent);
    expect(teamTasks.batch(f.db, batch.id)).toEqual(batch);
    expect(teamTasks.batch(f.db, batch.id)?.comments).toEqual([teamReviewComment(selected)]);
    expect(teamTasks.admission(f.db, admission.id)).toEqual(admission);
    expect(teamTasks.claim(f.db, selected.id)).toBe(batch.id);
    expect(teamTasks.batch(f.db, "missing")).toBeNull();
    expect(teamTasks.admission(f.db, "missing")).toBeNull();
  });

  it("replays exact captures and admission requests while rejecting altered accepted input", () => {
    const f = fixture();
    const intent = f.intent(f.task.id, { capture: { scope: "actor-scope", requestKey: "capture", payloadHash: hash } });
    expect(teamTasks.createIntent(f.db, intent)).toEqual(intent);
    expect(teamTasks.createIntent(f.db, intent)).toEqual(intent);
    expect(teamTasks.findCapture(f.db, f.instance.id, "actor-scope", "capture")).toEqual(intent);
    expect(teamTasks.findCapture(f.db, f.instance.id, "other-scope", "capture")).toBeNull();
    expect(() => teamTasks.createIntent(f.db, { ...intent, memberKey: "peer" })).toThrow();
    expect(() => teamTasks.createIntent(f.db, { ...intent, capture: { ...intent.capture!, payloadHash: "b".repeat(64) } })).toThrow();
    const admission = teamTasks.createAdmission(f.db, f.admission({ requestKey: "start-once" }));
    expect(teamTasks.createAdmission(f.db, admission)).toEqual(admission);
    expect(teamTasks.findRequest(f.db, f.instance.id, "start-once")).toEqual(admission);
    expect(teamTasks.findRequest(f.db, f.instance.id, "missing")).toBeNull();
    for (const changes of [{ input: { ...admission.input, spec: "Changed instructions" } }, { payloadHash: "b".repeat(64) }, { taskId: f.peer.id }]) {
      expect(() => teamTasks.createAdmission(f.db, { ...admission, ...changes })).toThrow();
    }
    expect(teamTasks.admissions(f.db, f.task.id)).toEqual([admission]);
    expect(teamTasks.intents(f.db, f.instance.id)).toEqual([intent]);
  });

  it("claims exactly the selected comments and rolls back the whole batch if any comment is already claimed", () => {
    const f = fixture();
    teamTasks.createIntent(f.db, f.intent());
    const first = f.addComment(f.task.id, "First comment");
    const second = f.addComment(f.task.id, "Second comment");
    const untouched = f.addComment(f.task.id, "Leave this unsent");
    const accepted = teamTasks.createBatch(f.db, f.batch([second]));
    expect(teamTasks.createBatch(f.db, accepted)).toEqual(accepted);
    const conflict = f.batch([first, second]);
    expect(() => teamTasks.createBatch(f.db, conflict)).toThrow();
    expect(teamTasks.batch(f.db, conflict.id)).toBeNull();
    expect(teamTasks.claim(f.db, first.id)).toBeNull();
    expect(teamTasks.claim(f.db, second.id)).toBe(accepted.id);
    expect(teamTasks.claim(f.db, untouched.id)).toBeNull();
    expect(() => teamTasks.createBatch(f.db, { ...accepted, comments: [second, untouched].map(teamReviewComment) })).toThrow();
    expect(() => teamTasks.createBatch(f.db, f.batch([first, first]))).toThrow();
    expect(rawCount(f.db, "team_review_batches")).toBe(1);
    expect(rawCount(f.db, "team_review_claims")).toBe(1);
  });

  it("rejects foreign owners, revisions, members, parent provenance and invalid dependencies", () => {
    const f = fixture();
    const other = fixture(f.db);
    const foreignThreadTask = tasks.insert(f.db, { projectId: f.project.id, title: "Unowned", spec: null, priority: "none", labels: [], workspaceMode: "worktree", baseRef: null, parentTaskId: null });
    const bad: Partial<TeamTaskIntent>[] = [
      { instanceId: other.instance.id },
      { teamRevisionId: other.saved.revision.id },
      { taskId: foreignThreadTask.id },
      { managerKey: "absent" },
      { memberKey: "absent" },
      { managerKey: "worker", memberKey: "peer" },
      { parentTaskId: f.manager.id },
      { dependencyTaskIds: [f.task.id] },
      { dependencyTaskIds: [other.task.id] },
      { dependencyTaskIds: [f.peer.id, f.peer.id] },
      { dependencyTaskIds: ["missing-task"] },
    ];
    for (const change of bad) expect(() => teamTasks.createIntent(f.db, f.intent(f.task.id, change))).toThrow();
    expect(teamTasks.intent(f.db, f.task.id)).toBeNull();
    teamTasks.createIntent(f.db, f.intent(f.peer.id, { memberKey: "peer" }));
    expect(teamTasks.createIntent(f.db, f.intent(f.task.id, { dependencyTaskIds: [f.peer.id] })).dependencyTaskIds).toEqual([f.peer.id]);
    teamTasks.createIntent(f.db, f.intent(f.manager.id, { memberKey: "manager" }));
    expect(teamTasks.createIntent(f.db, f.intent(f.nested.id, { managerKey: "manager", memberKey: "nested", parentTaskId: f.manager.id })).parentTaskId).toBe(f.manager.id);
  });

  it("requires source actors, snapshots and prior admissions to belong to the same task and instance", () => {
    const f = fixture();
    const other = fixture(f.db);
    teamTasks.createIntent(f.db, f.intent());
    teamTasks.createIntent(f.db, other.intent());
    const record = execution(f);
    const foreignRecord = execution(other);
    const foreign = teamTasks.createAdmission(f.db, other.admission());
    const run = runs.insert(f.db, { id: randomUUID(), taskId: f.task.id, threadId: null, ...settings, mode: "act", permissionMode: "trusted" });
    teamRuntime.update(f.db, record.id, (item) => {
      item.attempts.push({
        id: randomUUID(),
        actorId: "worker-1",
        runId: run.id,
        generation: 1,
        state: "starting",
        settings,
        configurationVersion: 1,
        directionVersion: 0,
        messageIds: [],
        attachments: [],
        snapshotId: null,
        error: null,
        createdAt: 1100,
        endedAt: null,
      });
    });
    const diffStat = { files: 1, insertions: 1, deletions: 0, untracked: 0 };
    const snapshot = snapshots.insert(f.db, { taskId: f.task.id, runId: run.id, turn: 1, treeSha: "a".repeat(40), diffStat });
    const foreignSnapshot = snapshots.insert(f.db, { taskId: f.peer.id, runId: null, turn: 1, treeSha: "b".repeat(40), diffStat });
    const source = { executionId: record.id, actorId: "worker-1", snapshotId: snapshot.id };
    const prior = teamTasks.createAdmission(f.db, f.admission({ source }));
    for (const changes of [
      { sourceAdmissionId: foreign.id },
      { source: { ...source, executionId: foreignRecord.id } },
      { source: { ...source, actorId: "peer-1" } },
      { source: { ...source, actorId: "absent" } },
      { source: { ...source, snapshotId: foreignSnapshot.id } },
    ])
      expect(() => teamTasks.createAdmission(f.db, f.admission(changes))).toThrow();
    expect(teamTasks.createAdmission(f.db, f.admission({ sourceAdmissionId: prior.id, source })).source).toEqual(source);
    for (const changes of [{ source: null }, { input: { ...prior.input, attachments: ["/managed/changed.png"] } }]) {
      expect(() => teamTasks.createAdmission(f.db, f.admission({ sourceAdmissionId: prior.id, source, ...changes }))).toThrow();
    }
    expect(() => teamTasks.createIntent(f.db, f.intent(f.peer.id, { memberKey: "peer", origin: { executionId: foreignRecord.id, actorId: "lead" } }))).toThrow();
    expect(() => teamTasks.createIntent(f.db, f.intent(f.peer.id, { memberKey: "peer", origin: { executionId: record.id, actorId: "nested-1" } }))).toThrow();
    expect(teamTasks.createIntent(f.db, f.intent(f.peer.id, { memberKey: "peer", origin: { executionId: record.id, actorId: "worker-1" } })).origin).toEqual({
      executionId: record.id,
      actorId: "worker-1",
    });
  });

  it("requires a previous task assignee route before accepting lead-owned review provenance", () => {
    const f = fixture();
    teamTasks.createIntent(f.db, f.intent(f.task.id, { memberKey: null }));
    const record = execution(f);
    const source = { executionId: record.id, actorId: "lead", snapshotId: null };
    expect(() => teamTasks.createAdmission(f.db, f.admission({ source }))).toThrow(/earlier matching assignee route/);
    const initial = teamTasks.createAdmission(f.db, f.admission());
    teamTasks.appendRoute(f.db, route(initial, record, { role: "assignee" }));
    const selected = f.addComment();
    const batch = teamTasks.createBatch(f.db, f.batch([selected]));
    expect(teamTasks.createAdmission(f.db, f.admission({ kind: "review", reviewBatchId: batch.id, source })).source).toEqual(source);
  });

  it("appends ordered actor routes and rejects wrong assignees, managers and mailbox recipients", () => {
    const f = fixture();
    teamTasks.createIntent(f.db, f.intent());
    const admission = teamTasks.createAdmission(f.db, f.admission());
    const record = execution(f);
    const first = teamTasks.appendRoute(f.db, route(admission, record));
    expect(teamTasks.appendRoute(f.db, first)).toEqual(first);
    for (const changes of [
      { sequence: 3 },
      { sequence: 2, actorId: "absent" },
      { sequence: 2, actorId: "peer-1", role: "assignee" as const },
      { sequence: 2, actorId: "nested-1", role: "manager" as const },
      { sequence: 2, actorId: "worker-1", role: "assignee" as const, messageId: "missing" },
    ])
      expect(() => teamTasks.appendRoute(f.db, route(admission, record, changes))).toThrow();
    const next = teamTasks.appendRoute(f.db, route(admission, record, { sequence: 2, actorId: "worker-1", role: "assignee" }));
    expect(teamTasks.routes(f.db, admission.id)).toEqual([first, next]);
    expect(teamTasks.routes(f.db, "missing")).toEqual([]);
  });

  it("rolls back intent, review claims, admission and route with an outer transaction", () => {
    const f = fixture();
    const record = execution(f);
    const selected = f.addComment();
    let admissionId = "";
    expect(() =>
      f.db.transaction(() => {
        teamTasks.createIntent(f.db, f.intent());
        const batch = teamTasks.createBatch(f.db, f.batch([selected]));
        const admission = teamTasks.createAdmission(f.db, f.admission({ kind: "review", reviewBatchId: batch.id }));
        admissionId = admission.id;
        teamTasks.appendRoute(f.db, route(admission, record));
        throw new Error("Later admission validation failed");
      }),
    ).toThrow("Later admission validation failed");
    expect(teamTasks.intent(f.db, f.task.id)).toBeNull();
    expect(teamTasks.claim(f.db, selected.id)).toBeNull();
    expect(teamTasks.admission(f.db, admissionId)).toBeNull();
    expect(teamTasks.routes(f.db, admissionId)).toEqual([]);
    expect(f.db.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("enforces retained rows, indexed payload identity and contiguous routes through raw SQL", () => {
    const f = fixture();
    const intent = teamTasks.createIntent(f.db, f.intent());
    const selected = f.addComment();
    const batch = teamTasks.createBatch(f.db, f.batch([selected]));
    const admission = teamTasks.createAdmission(f.db, f.admission({ kind: "review", reviewBatchId: batch.id }));
    const record = execution(f);
    const firstRoute = teamTasks.appendRoute(f.db, route(admission, record));
    for (const table of ["team_task_intents", "team_review_batches", "team_task_admissions", "team_task_admission_routes", "team_review_claims"]) {
      expect(() => f.db.stmt(`UPDATE ${table} SET rowid = rowid`).run()).toThrow(/immutable/);
      expect(() => f.db.stmt(`DELETE FROM ${table}`).run()).toThrow(/retained/);
      expect(rawCount(f.db, table)).toBe(1);
    }
    expect(() =>
      f.db
        .stmt("INSERT INTO team_task_intents(task_id,instance_id,revision_id,capture_scope,capture_key,payload,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(f.peer.id, f.instance.id, f.saved.revision.id, null, null, JSON.stringify(intent), intent.createdAt),
    ).toThrow(/indexed identity/);
    expect(() =>
      f.db.stmt("INSERT INTO team_review_batches(id,instance_id,task_id,payload,created_at) VALUES(?,?,?,?,?)").run(randomUUID(), f.instance.id, f.task.id, JSON.stringify(batch), batch.createdAt),
    ).toThrow(/indexed identity/);
    expect(() =>
      f.db
        .stmt("INSERT INTO team_task_admissions(id,instance_id,task_id,request_key,review_batch_id,source_admission_id,payload,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(randomUUID(), f.instance.id, f.task.id, "different-request", batch.id, null, JSON.stringify(admission), admission.createdAt),
    ).toThrow(/indexed identity/);
    expect(() => f.db.stmt("INSERT INTO team_review_claims(comment_id,batch_id) VALUES(?,?)").run("not-in-batch", batch.id)).toThrow(/immutable batch/);
    const rawRoute = (sequence: number, actorId: string) =>
      f.db
        .stmt("INSERT INTO team_task_admission_routes(admission_id,sequence,execution_id,actor_id,message_id,role,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(admission.id, sequence, record.id, actorId, null, "assignee", 3001);
    expect(() => rawRoute(3, "worker-1")).toThrow(/sequence/);
    expect(() => rawRoute(2, "missing-actor")).toThrow(/instance and actor/);
    expect(teamTasks.routes(f.db, admission.id)).toEqual([firstRoute]);
    expect(teamTasks.admission(f.db, admission.id)).toEqual(admission);
    expect(f.db.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("migrates fixed version 12 and reopens old runtime input alongside new task receipts", () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), "team-task-migration-"));
    folders.push(folder);
    const file = path.join(folder, "ledger.sqlite");
    const raw = new DatabaseSync(file);
    for (const migration of migrations.slice(0, 12)) typeof migration === "string" ? raw.exec(migration) : migration(raw);
    raw.exec("PRAGMA user_version = 12");
    raw.exec("PRAGMA foreign_keys = ON");
    const f = fixture(new Db(raw));
    const record = execution(f);
    const run = insertLegacyRun(f.db, { id: randomUUID(), taskId: null, threadId: f.thread.id, ...settings, mode: "act", permissionMode: "trusted" });
    const old = legacyTeamRuntime.update(f.db, record.id, (item) => {
      item.actors[0]!.directionVersion = 1;
      item.messages.push({
        id: "old-image-direction",
        sequence: 1,
        senderId: "user",
        recipientId: "lead",
        kind: "direction",
        body: "Preserve old design input",
        attachments: ["/managed/old-image.png"],
        dedupeKey: "old-direction",
        state: "pending",
        attemptId: null,
        createdAt: 1500,
        deliveredAt: null,
      });
      item.attempts.push({
        id: randomUUID(),
        actorId: "lead",
        runId: run.id,
        generation: 1,
        state: "starting",
        settings,
        configurationVersion: 1,
        directionVersion: 0,
        messageIds: [],
        attachments: ["/managed/original.png"],
        snapshotId: null,
        error: null,
        createdAt: 1100,
        endedAt: null,
      });
    }).record;
    // Written before comments belonged to conversations: the old table has no thread, line text or message.
    const legacyCommentId = randomUUID();
    f.db
      .stmt("INSERT INTO review_comments (id, task_id, snapshot_id, path, line, side, body, created_at) VALUES (?, ?, NULL, 'src/app.ts', 7, 'new', 'Keep the expected behavior', 1600)")
      .run(legacyCommentId, f.task.id);
    expect(f.db.version).toBe(12);
    close(f.db);
    const migrated = Db.open(file);
    opened.add(migrated);
    expect(migrated.version).toBe(migrations.length);
    const selected = comments.get(migrated, legacyCommentId)!;
    expect(selected).toEqual({
      id: legacyCommentId,
      threadId: null,
      taskId: f.task.id,
      snapshotId: null,
      path: "src/app.ts",
      startLine: null,
      startSide: null,
      line: 7,
      side: "new",
      lineText: null,
      body: "Keep the expected behavior",
      sentInRunId: null,
      sentMessageId: null,
      createdAt: 1600,
    });
    expect(teamRuntime.get(migrated, old.id)).toEqual(old);
    expect(teamRuntime.prompt(migrated, old.id, old.attempts[0]!.id)).toBe(LEGACY_TEAM_PROMPT);
    expect(teamTasks.intents(migrated, f.instance.id)).toEqual([]);
    const intent = teamTasks.createIntent(migrated, f.intent());
    const batch = teamTasks.createBatch(migrated, f.batch([selected]));
    const admission = teamTasks.createAdmission(migrated, f.admission({ kind: "review", reviewBatchId: batch.id }));
    const routed = teamTasks.appendRoute(migrated, route(admission, old, { messageId: "old-image-direction" }));
    close(migrated);
    const reopened = Db.open(file);
    opened.add(reopened);
    expect(teamRuntime.get(reopened, old.id)).toEqual(old);
    expect(teamRuntime.binding(reopened, run.id)?.executionId).toBe(old.id);
    expect(runs.get(reopened, run.id)).toEqual({ ...run, workingDirectory: null, commentTurnId: null });
    // A team task keeps its team conversation as the conversation it runs in.
    expect(tasks.get(reopened, f.task.id)).toEqual({ ...f.task, executionThreadId: f.thread.id });
    expect(comments.listForTask(reopened, f.task.id)).toEqual([selected]);
    expect(orchestration.getInstance(reopened, f.thread.id)).toEqual(f.instance);
    expect(teamTasks.intent(reopened, f.task.id)).toEqual(intent);
    expect(teamTasks.batch(reopened, batch.id)).toEqual(batch);
    expect(teamTasks.claim(reopened, selected.id)).toBe(batch.id);
    expect(teamTasks.findRequest(reopened, f.instance.id, admission.requestKey)).toEqual(admission);
    expect(teamTasks.createAdmission(reopened, admission)).toEqual(admission);
    expect(teamTasks.routes(reopened, admission.id)).toEqual([routed]);
    expect(reopened.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("retains a captured dependency task until its dependent task history is removed with the owner", () => {
    const f = fixture();
    teamTasks.createIntent(f.db, f.intent(f.peer.id, { memberKey: "peer" }));
    const dependent = teamTasks.createIntent(f.db, f.intent(f.task.id, { dependencyTaskIds: [f.peer.id] }));
    expect(() => tasks.delete(f.db, f.peer.id)).toThrow();
    expect(tasks.get(f.db, f.peer.id)).toEqual(f.peer);
    expect(teamTasks.intent(f.db, f.task.id)).toEqual(dependent);
    threads.delete(f.db, f.thread.id);
    expect(rawCount(f.db, "team_task_intents")).toBe(0);
    expect(f.db.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("retains an unassigned manager task instead of nulling its captured child's parent", () => {
    const f = fixture();
    teamTasks.createIntent(f.db, f.intent(f.manager.id, { memberKey: "manager" }));
    const child = teamTasks.createIntent(f.db, f.intent(f.nested.id, { managerKey: "manager", memberKey: "nested", parentTaskId: f.manager.id }));
    expect(() => tasks.delete(f.db, f.manager.id)).toThrow();
    expect(tasks.get(f.db, f.nested.id)?.parentTaskId).toBe(f.manager.id);
    expect(teamTasks.intent(f.db, f.nested.id)).toEqual(child);
    f.db.stmt("DELETE FROM projects WHERE id = ?").run(f.project.id);
    expect(rawCount(f.db, "team_task_intents")).toBe(0);
    expect(f.db.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it.each(["task", "thread"] as const)("retains intent-origin executions without routes and permits %s owner cleanup", (kind) => {
    const f = fixture();
    const record = leadExecution(f);
    const intent = teamTasks.createIntent(f.db, f.intent(f.task.id, { origin: { executionId: record.id, actorId: "lead" } }));
    expect(rawCount(f.db, "team_task_admission_routes")).toBe(0);
    expect(() => f.db.stmt("DELETE FROM team_executions WHERE id = ?").run(record.id)).toThrow();
    expect(teamTasks.intent(f.db, f.task.id)).toEqual(intent);
    deleteOwner(f, kind);
    expect(teamTasks.intent(f.db, f.task.id)).toBeNull();
    if (kind === "task") f.db.stmt("DELETE FROM team_executions WHERE id = ?").run(record.id);
    expect(teamRuntime.get(f.db, record.id)).toBeNull();
    expect(f.db.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it.each(["thread"] as const)("retains admission-source executions without routes and permits %s owner cleanup", (kind) => {
    const f = fixture();
    teamTasks.createIntent(f.db, f.intent());
    const record = execution(f);
    const admission = teamTasks.createAdmission(f.db, f.admission({ source: { executionId: record.id, actorId: "worker-1", snapshotId: null } }));
    expect(rawCount(f.db, "team_task_admission_routes")).toBe(0);
    expect(() => f.db.stmt("DELETE FROM team_executions WHERE id = ?").run(record.id)).toThrow();
    expect(teamTasks.admission(f.db, admission.id)).toEqual(admission);
    deleteOwner(f, kind);
    expect(teamTasks.admission(f.db, admission.id)).toBeNull();
    expect(teamRuntime.get(f.db, record.id)).toBeNull();
    expect(f.db.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it.each(["task", "thread", "instance", "project"] as const)("retains accepted review snapshots after source comment deletion and permits %s cleanup", (kind) => {
    const f = fixture();
    teamTasks.createIntent(f.db, f.intent());
    const snapshot = snapshots.insert(f.db, { taskId: f.task.id, runId: null, turn: 1, treeSha: "a".repeat(40), diffStat: { files: 1, insertions: 1, deletions: 0, untracked: 0 } });
    const comment = comments.insert(f.db, {
      threadId: null,
      taskId: f.task.id,
      snapshotId: snapshot.id,
      path: "src/app.ts",
      startLine: null,
      startSide: null,
      line: 7,
      side: "new",
      lineText: null,
      body: "Review this exact version",
    });
    const batch = teamTasks.createBatch(f.db, f.batch([comment]));
    comments.remove(f.db, comment.id);
    expect(() => f.db.stmt("DELETE FROM snapshots WHERE id = ?").run(snapshot.id)).toThrow();
    expect(teamTasks.batch(f.db, batch.id)).toEqual(batch);
    expect(snapshots.get(f.db, snapshot.id)).toEqual(snapshot);
    deleteOwner(f, kind);
    expect(teamTasks.batch(f.db, batch.id)).toBeNull();
    if (kind === "instance" || kind === "thread") f.db.stmt("DELETE FROM snapshots WHERE id = ?").run(snapshot.id);
    expect(snapshots.get(f.db, snapshot.id)).toBeNull();
    expect(f.db.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it.each(["thread", "instance", "project"] as const)("retains exact source-run snapshots and permits %s owner cleanup", (kind) => {
    const f = fixture();
    teamTasks.createIntent(f.db, f.intent());
    const record = execution(f);
    const snapshot = sourceSnapshot(f, record);
    const admission = teamTasks.createAdmission(f.db, f.admission({ source: { executionId: record.id, actorId: "worker-1", snapshotId: snapshot.id } }));
    expect(() => f.db.stmt("DELETE FROM snapshots WHERE id = ?").run(snapshot.id)).toThrow();
    expect(teamTasks.admission(f.db, admission.id)).toEqual(admission);
    expect(snapshots.get(f.db, snapshot.id)).toEqual(snapshot);
    deleteOwner(f, kind);
    expect(teamTasks.admission(f.db, admission.id)).toBeNull();
    if (kind === "instance" || kind === "thread") f.db.stmt("DELETE FROM snapshots WHERE id = ?").run(snapshot.id);
    expect(snapshots.get(f.db, snapshot.id)).toBeNull();
    expect(f.db.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it.each(["task", "thread"] as const)("cascades new retained input with its %s owner without dangling references", (kind) => {
    const f = fixture();
    teamTasks.createIntent(f.db, f.intent());
    const selected = f.addComment();
    const batch = teamTasks.createBatch(f.db, f.batch([selected]));
    const admission = teamTasks.createAdmission(f.db, f.admission({ kind: "review", reviewBatchId: batch.id }));
    teamTasks.createAdmission(f.db, { ...admission, id: randomUUID(), requestKey: "retry", sourceAdmissionId: admission.id });
    // Route to the lead without reserving the task in the legacy actor-binding
    // table: its independent retention rule is outside task admission cleanup.
    const record = teamRuntime.create(f.db, {
      id: randomUUID(),
      instanceId: f.instance.id,
      threadId: f.thread.id,
      projectId: f.project.id,
      state: "active",
      generation: 1,
      revision: 0,
      limits: draft.limits,
      actors: [actor("lead", "root", null, null)],
      attempts: [],
      messages: [],
      error: null,
      createdAt: 1000,
      updatedAt: 1000,
      deadlineAt: 3601000,
    });
    teamTasks.appendRoute(f.db, route(admission, record));
    deleteOwner(f, kind);
    for (const table of ["team_task_intents", "team_review_batches", "team_task_admissions", "team_task_admission_routes", "team_review_claims"]) expect(rawCount(f.db, table)).toBe(0);
    expect(f.db.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
