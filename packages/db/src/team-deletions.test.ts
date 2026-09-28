import { insertLegacyRun } from "./fixtures/legacy-run.js";
import { teamJournalWriter } from "./fixtures/legacy-team-journal.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TEAM_LIMITS, type TeamExecutionRecord, type TeamTaskAdmission, type TeamTreeCapture } from "@openorc/protocol";
import { Db } from "./database.js";
import { migrations } from "./schema.js";
import { orchestration } from "./orchestration.js";
import { insertLegacyCheckpoint } from "./fixtures/legacy-checkpoint.js";
import { projects, runs, tasks, threads } from "./repos.js";
import { messages } from "./search.js";
import { teamRuntime } from "./team-runtime.js";
import { teamContexts } from "./team-context.js";
import { teamWorkspaces } from "./team-workspaces.js";
import { teamTasks } from "./team-tasks.js";
import { teamForks, type CreateTeamForkInput } from "./team-forks.js";
import { teamRestores, type CreateTeamRestoreInput } from "./team-restores.js";
import { teamMoves, type CreateTeamMoveInput } from "./team-moves.js";
import { teamDeletedThreads, teamDeletions, type CreateTeamDeletionInput, type TeamCleanupEntry, type TeamDeletionRecord } from "./team-deletions.js";
import { teamDeleteMigration } from "./team-delete-schema.js";

const opened = new Set<Db>(),
  folders: string[] = [];
afterEach(() => {
  for (const db of opened) db.close();
  opened.clear();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const settings = { agent: "codex" as const, model: "fixture", effort: "high", fastMode: false };
const hash = "a".repeat(64),
  sha = (value: string) => value.repeat(40);
const diffStat = { files: 1, insertions: 1, deletions: 0, untracked: 0 };
const flags = ["archivedAt", "doneAt", "snoozedUntil", "pinnedAt"] as const;
function snapshot(rootPath: string, head = "1", tree = "2"): TeamTreeCapture {
  return { rootPath, headSha: sha(head), treeSha: sha(tree), branch: null, treeRef: "refs/openorc/tests/tree", headRef: "refs/openorc/tests/head", indexSha256: "3".repeat(64) };
}
function entry(path: string, patch: Partial<TeamCleanupEntry> = {}): TeamCleanupEntry {
  return { path, canonicalPath: "/private" + path, repositoryRoot: "/tmp/repo", commonDir: "/tmp/repo/.git", quarantinePath: path + ".deleting", identity: null, registration: null, ...patch };
}
const boundary = (db: Db, threadId: string) => (db.stmt("SELECT COALESCE(MAX(rowid),0) AS value FROM team_executions WHERE thread_id=?").get(threadId) as { value: number }).value;
const ids = (items: { id: string }[]) => items.map((item) => item.id);

function fixture(db = Db.memory(), taskCount = 0) {
  opened.add(db);
  const project = projects.insert(db, { name: "Deletion journal", rootPath: "/tmp/" + randomUUID(), defaultBranch: "main", gitRemote: null, settings: {} });
  const saved = orchestration.save(db, {
    projectId: project.id,
    expectedRevisionId: null,
    draft: {
      name: "Deletion team",
      limits: DEFAULT_TEAM_LIMITS,
      members: [
        { key: "lead", name: "Lead", managerKey: null, responsibility: "Work", settings },
        { key: "worker", name: "Worker", managerKey: "lead", responsibility: "Implement", settings },
      ],
    },
  });
  const workspace = "/tmp/team-workspaces/" + randomUUID();
  let thread = threads.insert(db, { projectId: project.id, title: "Delete this team", ...settings, mode: "act", permissionMode: "review", workspaceMode: "worktree" });
  thread = threads.update(db, thread.id, { worktreePath: workspace, baseSha: sha("1"), branch: "openorc/team-" + thread.id });
  const instance = orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: saved.revision.id });
  const run = insertLegacyRun(db, { id: randomUUID(), threadId: thread.id, taskId: null, ...settings, mode: "act", permissionMode: "review" });
  runs.update(db, run.id, { state: "success", endedAt: 100 });
  const checkpoint = insertLegacyCheckpoint(db, { threadId: thread.id, runId: run.id, turn: 1, treeSha: sha("2"), diffStat });
  const initial = teamJournalWriter(db).create(db, {
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
        input: { title: "Team work", spec: "Original instructions", attachments: [], responsibility: "Work", settings },
        state: "completed",
        retries: 0,
        directionVersion: 0,
        deliveredVersion: 0,
        disposition: null,
        result: "Accepted output",
        snapshotId: checkpoint.id,
        error: null,
      },
    ],
    attempts: [],
    messages: [],
    error: null,
    createdAt: 1,
    updatedAt: 100,
    deadlineAt: 1000,
  });
  const execution = teamJournalWriter(db).update(db, initial.id, (record) => {
    record.state = "completed";
    record.attempts.push({
      id: randomUUID(),
      actorId: "lead",
      runId: run.id,
      generation: 1,
      state: "closed",
      settings,
      configurationVersion: 1,
      directionVersion: 0,
      messageIds: [],
      snapshotId: checkpoint.id,
      error: null,
      createdAt: 10,
      endedAt: 100,
    });
  }).record;
  const retained = Array.from({ length: taskCount }, (_, index) =>
    tasks.insert(db, {
      projectId: project.id,
      threadId: thread.id,
      title: `Saved task ${index}`,
      spec: `Spec ${index}`,
      priority: "none",
      labels: [],
      workspaceMode: "worktree",
      baseRef: "main",
      parentTaskId: null,
      origin: "agent",
    }),
  );
  if (retained[1]) tasks.update(db, retained[1].id, { status: "archived" });
  const input: CreateTeamDeletionInput = {
    id: randomUUID(),
    threadId: thread.id,
    instanceId: instance.id,
    projectId: project.id,
    projectRoot: project.rootPath,
    requestKey: "delete-once",
    requestHash: hash,
    retainedTaskIds: ids(retained),
    retainedPaths: [],
    throughExecutionRowid: boundary(db, thread.id),
    entries: taskCount ? [] : [entry(workspace, { repositoryRoot: project.rootPath, commonDir: project.rootPath + "/.git" })],
    seed: taskCount ? "Saved tasks keep their team" : null,
  };
  return { db, project, saved, thread, workspace, instance, run, checkpoint, execution, retained, input };
}
type Fixture = ReturnType<typeof fixture>;
const captured = (f: Fixture, patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    projectRoot: f.input.projectRoot,
    retainedTaskIds: f.input.retainedTaskIds,
    entries: f.input.entries,
    retainedPaths: [],
    seed: f.input.seed,
    throughExecutionRowid: f.input.throughExecutionRowid,
    ...patch,
  });
function rawInsert(f: Fixture, patch: Record<string, unknown> = {}, owner: Partial<Record<"id" | "threadId" | "instanceId" | "projectId", string>> = {}) {
  return f.db
    .stmt("INSERT INTO team_deletions(id,thread_id,instance_id,project_id,request_key,request_hash,captured_input,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'pending',1,1)")
    .run(owner.id ?? randomUUID(), owner.threadId ?? f.thread.id, owner.instanceId ?? f.instance.id, owner.projectId ?? f.project.id, randomUUID(), hash, captured(f, patch));
}
function context(db: Db, record: Pick<TeamDeletionRecord, "id" | "instanceId" | "seed">, patch: Partial<Parameters<typeof teamContexts.create>[1]> = {}) {
  return teamContexts.create(db, {
    instanceId: record.instanceId,
    executionId: null,
    actorId: "lead",
    originExecutionId: null,
    reason: "compact",
    requestKey: "delete:" + record.id,
    seed: record.seed ?? "",
    ...patch,
  });
}
function hide(f: Fixture) {
  const record = teamDeletions.create(f.db, f.input),
    checkpoint = context(f.db, record);
  return { record: teamDeletions.finish(f.db, record.id, { contextCheckpointId: checkpoint.id }), checkpoint };
}
function forkInput(f: Fixture): CreateTeamForkInput {
  return {
    id: randomUUID(),
    sourceThreadId: f.thread.id,
    sourceInstanceId: f.instance.id,
    projectId: f.project.id,
    projectRoot: f.project.rootPath,
    destinationThreadId: randomUUID(),
    requestKey: "fork",
    requestHash: hash,
    setupInput: null,
    seed: "Fork context",
    sourceRunId: null,
    upToRunId: null,
    teamRevisionId: f.saved.revision.id,
    leadOverrides: {},
    thread: { title: "Fork", ...settings, mode: "act", permissionMode: "review" },
    snapshot: snapshot(f.project.rootPath),
  };
}
function restoreInput(f: Fixture): CreateTeamRestoreInput {
  return {
    id: randomUUID(),
    threadId: f.thread.id,
    instanceId: f.instance.id,
    projectId: f.project.id,
    projectRoot: f.project.rootPath,
    requestKey: "restore",
    requestHash: hash,
    checkpointId: f.checkpoint.id,
    sourceRunId: f.run.id,
    sourcePath: f.workspace,
    targetTree: f.checkpoint.treeSha,
    setupInput: null,
    seed: "Restore context",
    before: snapshot("/private" + f.workspace),
  };
}
function moveInput(f: Fixture): CreateTeamMoveInput {
  return {
    id: randomUUID(),
    threadId: f.thread.id,
    instanceId: f.instance.id,
    projectId: f.project.id,
    projectRoot: f.project.rootPath,
    requestKey: "move",
    requestHash: hash,
    from: "worktree",
    to: "current",
    sourcePath: f.workspace,
    source: snapshot("/private" + f.workspace),
    setupInput: null,
    destinationBefore: snapshot("/private" + f.project.rootPath, "4", "5"),
    deltas: [{ baseTree: sha("6"), outputTree: sha("2") }],
    originMoveId: null,
    publicationBranch: f.thread.branch,
    seed: "Move context",
  };
}
function intentFor(f: Fixture, taskId: string) {
  return teamTasks.createIntent(f.db, {
    taskId,
    instanceId: f.instance.id,
    teamRevisionId: f.saved.revision.id,
    managerKey: "lead",
    memberKey: "worker",
    parentTaskId: null,
    dependencyTaskIds: [],
    origin: null,
    capture: null,
    createdAt: 1000,
  });
}
function admissionFor(f: Fixture, taskId: string): TeamTaskAdmission {
  return {
    id: randomUUID(),
    instanceId: f.instance.id,
    taskId,
    requestKey: "start-saved-task",
    payloadHash: hash,
    kind: "start",
    input: { title: "Saved task", spec: "Spec", attachments: [] },
    reviewBatchId: null,
    sourceAdmissionId: null,
    source: null,
    createdAt: 2000,
  };
}
function freshExecution(f: Fixture, admission?: TeamExecutionRecord["admission"]): TeamExecutionRecord {
  return {
    id: randomUUID(),
    instanceId: f.instance.id,
    threadId: f.thread.id,
    projectId: f.project.id,
    ...(admission ? { admission } : {}),
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
        input: { title: "Later work", spec: "Continue", attachments: [], responsibility: "Work", settings },
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
    createdAt: 3000,
    updatedAt: 3000,
    deadlineAt: 4000,
  };
}
/** Paths another conversation already owns or has reserved, each of which a deletion must refuse to touch. */
function foreignPaths(db: Db) {
  const other = fixture(db, 1);
  const paths = {
    thread: other.workspace,
    task: "/tmp/task-worktree-" + randomUUID(),
    workspace: "/tmp/other-workspace-" + randomUUID(),
    fork: "/tmp/fork-candidate-" + randomUUID(),
    restore: "/tmp/restore-candidate-" + randomUUID(),
    move: "/tmp/move-candidate-" + randomUUID(),
  };
  tasks.update(db, other.retained[0]!.id, { worktreePath: paths.task });
  teamWorkspaces.save(db, {
    id: randomUUID(),
    executionId: other.execution.id,
    actorId: "lead",
    taskId: null,
    parentActorId: null,
    path: paths.workspace,
    source: snapshot(other.project.rootPath),
    state: "ready",
    setupState: "completed",
    preparedTree: null,
    outputTree: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
  });
  teamForks.appendPath(db, teamForks.create(db, forkInput(other)).id, paths.fork);
  teamRestores.appendPath(db, teamRestores.create(db, restoreInput(other)).id, paths.restore);
  teamMoves.appendPath(db, teamMoves.create(db, moveInput(other)).id, { path: paths.move, kind: "scratch" });
  return { other, paths };
}

describe("durable team deletion receipts", () => {
  it("captures the exact owner, every saved task including archived ones, and the execution boundary", () => {
    const f = fixture(Db.memory(), 2),
      other = fixture(f.db, 1),
      bare = fixture(f.db),
      [kept, archived] = f.input.retainedTaskIds as [string, string];
    expect(tasks.get(f.db, archived)?.status).toBe("archived");
    for (const patch of [{ threadId: other.thread.id }, { instanceId: other.instance.id }, { projectId: other.project.id }, { projectRoot: "/tmp/elsewhere" }]) {
      expect(() => teamDeletions.create(f.db, { ...f.input, ...patch })).toThrow(/exact thread, instance and project/);
    }
    for (const retainedTaskIds of [[kept], [archived], [kept, archived, randomUUID()], [kept, other.retained[0]!.id]]) {
      expect(() => teamDeletions.create(f.db, { ...f.input, retainedTaskIds })).toThrow(/match every current task/);
    }
    expect(() => teamDeletions.create(f.db, { ...f.input, throughExecutionRowid: f.input.throughExecutionRowid + 1 })).toThrow(/execution history changed/);
    for (const patch of [{ retainedTaskIds: [kept, kept] }, { entries: [entry(f.workspace)] }, { seed: null }, { seed: " " }]) {
      expect(() => teamDeletions.create(f.db, { ...f.input, ...patch })).toThrow(/Retained tasks need a fresh context/);
    }
    expect(() => teamDeletions.create(bare.db, { ...bare.input, seed: "Unneeded" })).toThrow(/taskless deletion needs no context/);
    expect(() => teamDeletions.create(bare.db, { ...bare.input, entries: [], retainedTaskIds: [other.retained[0]!.id], seed: "Foreign" })).toThrow(/match every current task/);
    for (const patch of [
      { retainedTaskIds: [kept] },
      { retainedTaskIds: [kept, archived, randomUUID()] },
      { retainedTaskIds: [kept, kept, archived] },
      { retainedTaskIds: [kept, other.retained[0]!.id] },
      { throughExecutionRowid: f.input.throughExecutionRowid + 1 },
      { throughExecutionRowid: 0 },
      { throughExecutionRowid: -1 },
      { retainedTaskIds: [], seed: null },
      { projectRoot: "/tmp/elsewhere" },
      { projectRoot: "relative" },
    ]) {
      expect(() => rawInsert(f, patch)).toThrow(/exact owner, every saved task/);
    }
    for (const owner of [{ threadId: other.thread.id }, { instanceId: other.instance.id }, { projectId: other.project.id }]) {
      expect(() => rawInsert(f, {}, owner)).toThrow(/exact owner, every saved task/);
    }
    for (const patch of [{ entries: [entry(f.workspace)] }, { seed: null }, { seed: "" }, { retainedPaths: "none" }]) expect(() => rawInsert(f, patch)).toThrow(/CHECK/);
    expect(() => rawInsert(bare, { seed: "Unneeded" })).toThrow(/CHECK/);
    expect(() => rawInsert(bare, { entries: [], retainedTaskIds: [other.retained[0]!.id], seed: "Foreign" })).toThrow(/exact owner, every saved task/);
    expect(teamDeletions.list(f.db)).toEqual([]);
    expect(teamDeletions.get(f.db, "missing")).toBeNull();
    const record = teamDeletions.create(f.db, f.input);
    expect(record).toMatchObject({ ...f.input, state: "pending", items: [], appliedContextId: null, error: null });
    expect(record.updatedAt).toBe(record.createdAt);
    expect(teamDeletions.create(f.db, f.input)).toEqual(record);
    expect(teamDeletions.find(f.db, f.thread.id, f.input.requestKey)).toEqual(record);
    expect(teamDeletions.find(f.db, f.thread.id, "unknown")).toBeNull();
    expect(teamDeletions.pendingForThread(f.db, f.thread.id)).toEqual([record]);
    expect(teamDeletions.pending(f.db)).toEqual([record]);
    expect(teamDeletions.list(f.db)).toEqual([record]);
    for (const patch of [{ id: randomUUID() }, { instanceId: other.instance.id }, { requestHash: "b".repeat(64) }, { seed: "Changed context" }, { retainedTaskIds: [archived, kept] }]) {
      expect(() => teamDeletions.create(f.db, { ...f.input, ...patch })).toThrow(/already identifies different captured work/);
    }
    expect(() => teamDeletions.create(f.db, { ...f.input, id: randomUUID(), requestKey: "concurrent" })).toThrow(/UNIQUE/);
    expect(() => rawInsert(f)).toThrow(/UNIQUE/);
    expect(() => f.db.stmt("UPDATE team_deletions SET captured_input=json_set(captured_input,'$.seed','changed') WHERE id=?").run(record.id)).toThrow(/immutable/);
    expect(() => f.db.stmt("UPDATE team_deletions SET request_hash=? WHERE id=?").run("b".repeat(64), record.id)).toThrow(/immutable/);
    expect(() => f.db.stmt("UPDATE team_deletions SET state='applied',applied_context_id='x',updated_at=updated_at+1 WHERE id=?").run(record.id)).toThrow(/hidden owner marker or the absent owner/);
    expect(() => f.db.stmt("DELETE FROM team_deletions WHERE id=?").run(record.id)).toThrow(/retained independently/);
    expect(teamDeletions.get(f.db, record.id)).toEqual(record);
  });

  it("retains rejections that can never be admitted and refuses to reject an admitted request", () => {
    const f = fixture();
    const denied = { threadId: f.thread.id, requestKey: f.input.requestKey, requestHash: hash, error: "Workspace ownership could not be proven." };
    expect(teamDeletions.rejection(f.db, denied.threadId, denied.requestKey)).toBeNull();
    expect(() =>
      f.db.transaction(() => {
        teamDeletions.reject(f.db, denied);
        throw Error("rollback");
      }),
    ).toThrow(/rollback/);
    expect(teamDeletions.rejection(f.db, denied.threadId, denied.requestKey)).toBeNull();
    const receipt = teamDeletions.reject(f.db, denied);
    expect(teamDeletions.reject(f.db, denied)).toEqual(receipt);
    expect(teamDeletions.rejection(f.db, denied.threadId, denied.requestKey)).toEqual(receipt);
    for (const patch of [{ requestHash: "b".repeat(64) }, { error: "A different reason" }]) expect(() => teamDeletions.reject(f.db, { ...denied, ...patch })).toThrow(/different rejection/);
    for (const patch of [{ threadId: " " }, { requestKey: "" }, { requestKey: "x".repeat(201) }, { requestHash: "bad" }, { error: " " }])
      expect(() => teamDeletions.reject(f.db, { ...denied, ...patch })).toThrow();
    expect(() => teamDeletions.create(f.db, f.input)).toThrow(/rejected and cannot later be admitted/);
    expect(() => rawInsert(f, { entries: [] }, { id: f.input.id })).not.toThrow();
    expect(() => f.db.stmt("UPDATE team_deletion_rejections SET error='changed' WHERE thread_id=?").run(f.thread.id)).toThrow(/immutable/);
    expect(() => f.db.stmt("DELETE FROM team_deletion_rejections WHERE thread_id=?").run(f.thread.id)).toThrow(/retained independently/);
    f.db.stmt("UPDATE team_deletions SET state='attention',error='keep' WHERE id=?").run(f.input.id);
    const admitted = teamDeletions.get(f.db, f.input.id)!;
    expect(admitted.state).toBe("attention");
    expect(() => teamDeletions.reject(f.db, { ...denied, requestKey: admitted.requestKey })).toThrow(/admitted deletion request cannot be rejected/);
    expect(() => f.db.stmt("INSERT INTO team_deletion_rejections(thread_id,request_key,request_hash,error,created_at) VALUES(?,?,?,?,1)").run(f.thread.id, admitted.requestKey, hash, "Raw")).toThrow(
      /admitted deletion request cannot be rejected/,
    );
    expect(teamDeletions.rejection(f.db, f.thread.id, admitted.requestKey)).toBeNull();
    expect(teamDeletions.reject(f.db, { ...denied, requestKey: "another-request" }).requestKey).toBe("another-request");
  });

  it("admits only owned workspaces, never a project root, another conversation's or task's worktree, a foreign team workspace or a reserved candidate", () => {
    const f = fixture(),
      { other, paths } = foreignPaths(f.db);
    const create = (item: TeamCleanupEntry) => () => teamDeletions.create(f.db, { ...f.input, entries: [item] });
    for (const patch of [{ path: f.project.rootPath }, { canonicalPath: f.project.rootPath }, { quarantinePath: f.project.rootPath }]) {
      expect(create(entry(f.workspace, patch))).toThrow(/preserve the project checkout/);
      expect(() => rawInsert(f, { entries: [entry(f.workspace, patch)] })).toThrow(/only owned workspaces/);
    }
    for (const patch of [{ path: other.project.rootPath }, { canonicalPath: other.project.rootPath }, { quarantinePath: other.project.rootPath }]) {
      expect(create(entry(f.workspace, patch))).toThrow(/only owned workspaces/);
    }
    for (const path of Object.values(paths)) {
      expect(create(entry(path))).toThrow(/only owned workspaces/);
      expect(create(entry(f.workspace, { canonicalPath: path }))).toThrow(/only owned workspaces/);
    }
    for (const patch of [{ path: "relative" }, { canonicalPath: "/tmp/a/../b" }, { quarantinePath: "relative" }]) expect(create(entry(f.workspace, patch))).toThrow(/normalized and absolute/);
    const registration = { gitDir: f.project.rootPath + "/.git/worktrees/x", gitDirIdentity: { dev: "1", ino: "2", birthtimeNs: "3" }, marker: "gitdir: x", head: sha("a"), branch: null };
    for (const patch of [{ quarantinePath: f.workspace }, { quarantinePath: "/private" + f.workspace }, { registration }])
      expect(create(entry(f.workspace, patch))).toThrow(/distinct quarantine path/);
    for (const patch of [{ path: "relative" }, { canonicalPath: "relative" }, { quarantinePath: "relative" }, { quarantinePath: f.workspace }, { quarantinePath: "/private" + f.workspace }]) {
      expect(() => rawInsert(f, { entries: [entry(f.workspace, patch)] })).toThrow(/only owned workspaces/);
    }
    expect(teamDeletions.list(f.db)).toEqual([]);
    teamWorkspaces.save(f.db, {
      id: randomUUID(),
      executionId: f.execution.id,
      actorId: "lead",
      taskId: null,
      parentActorId: null,
      path: f.workspace,
      source: snapshot(f.project.rootPath),
      state: "ready",
      setupState: "completed",
      preparedTree: null,
      outputTree: null,
      error: null,
      createdAt: 1,
      updatedAt: 1,
    });
    const record = teamDeletions.create(f.db, f.input);
    expect(record.entries).toEqual(f.input.entries);
    expect(record.items).toEqual([{ index: 0, state: "pending", updatedAt: record.createdAt }]);
  });

  it("keeps canonical and quarantine destinations unique within a receipt and across every retained receipt", () => {
    const f = fixture(),
      other = fixture(f.db),
      a = entry(f.workspace),
      b = entry(f.workspace + "-scratch");
    const collisions = [{ canonicalPath: a.canonicalPath }, { quarantinePath: a.canonicalPath }, { canonicalPath: a.quarantinePath }, { quarantinePath: a.quarantinePath }];
    for (const patch of collisions) {
      expect(() => teamDeletions.create(f.db, { ...f.input, entries: [a, { ...b, ...patch }] })).toThrow(/unique destinations/);
      expect(() => rawInsert(f, { entries: [a, { ...b, ...patch }] })).toThrow(/only owned workspaces/);
    }
    expect(() => teamDeletions.create(f.db, { ...f.input, entries: [a, { ...b, path: a.path }] })).toThrow(/unique destinations/);
    const record = teamDeletions.create(f.db, { ...f.input, entries: [a, b] });
    expect(record.items).toHaveLength(2);
    for (const patch of collisions) {
      expect(() => teamDeletions.create(other.db, { ...other.input, entries: [entry(other.workspace, patch)] })).toThrow(/only owned workspaces/);
    }
    expect(teamDeletions.create(other.db, other.input).entries).toEqual(other.input.entries);
  });

  it("advances cleanup items forward only and keeps the journal aligned with the inventory", () => {
    const f = fixture(),
      other = fixture(f.db);
    const record = teamDeletions.create(f.db, { ...f.input, entries: [f.input.entries[0]!, entry(f.workspace + "-scratch")] });
    expect(() => teamDeletions.markItem(f.db, record.id, 2, "removed")).toThrow(/does not belong to this inventory/);
    expect(() => teamDeletions.markItem(f.db, "missing", 0, "removed")).toThrow(/not found/);
    let progressed = teamDeletions.markItem(f.db, record.id, 0, "quarantined");
    expect(progressed.items.map((item) => item.state)).toEqual(["quarantined", "pending"]);
    expect(progressed.updatedAt).toBe(progressed.items[0]!.updatedAt);
    expect(teamDeletions.markItem(f.db, record.id, 0, "quarantined")).toEqual(progressed);
    progressed = teamDeletions.markItem(f.db, record.id, 0, "removed");
    progressed = teamDeletions.markItem(f.db, record.id, 1, "removed");
    expect(progressed.items.map((item) => item.state)).toEqual(["removed", "removed"]);
    for (const state of ["quarantined", "pending"] as const) expect(() => teamDeletions.markItem(f.db, record.id, 0, state)).toThrow(/only advances/);
    const held = teamDeletions.markItem(other.db, teamDeletions.create(other.db, other.input).id, 0, "quarantined");
    expect(() => teamDeletions.markItem(other.db, held.id, 0, "pending")).toThrow(/only advances/);
    expect(() => f.db.stmt("UPDATE team_deletion_items SET state='pending' WHERE deletion_id=?").run(record.id)).toThrow(/only advances/);
    expect(() => f.db.stmt("UPDATE team_deletion_items SET updated_at=updated_at-1 WHERE deletion_id=?").run(record.id)).toThrow(/only advances/);
    expect(() => f.db.stmt("UPDATE team_deletion_items SET item_index=5 WHERE deletion_id=? AND item_index=1").run(record.id)).toThrow(/only advances/);
    expect(() => f.db.stmt("INSERT INTO team_deletion_items(deletion_id,item_index,state,updated_at) VALUES(?,2,'pending',?)").run(record.id, Date.now())).toThrow(/mirror the immutable inventory/);
    expect(() => f.db.stmt("INSERT INTO team_deletion_items(deletion_id,item_index,state,updated_at) VALUES(?,1,'removed',?)").run(held.id, Date.now())).toThrow(/mirror the immutable inventory/);
    expect(() => f.db.stmt("INSERT INTO team_deletion_items(deletion_id,item_index,state,updated_at) VALUES(?,0,'pending',?)").run(randomUUID(), Date.now())).toThrow(/mirror the immutable inventory/);
    expect(() => f.db.stmt("DELETE FROM team_deletion_items WHERE deletion_id=?").run(record.id)).toThrow(/retained with their receipts/);
    const flagged = teamDeletions.attention(f.db, record.id, "Quarantine failed");
    expect(flagged).toMatchObject({ state: "attention", error: "Quarantine failed", items: progressed.items });
    expect(() => teamDeletions.attention(f.db, record.id, " ")).toThrow();
    expect(() => f.db.stmt("UPDATE team_deletions SET state='pending',error=NULL WHERE id=?").run(record.id)).toThrow(/immutable/);
    expect(teamDeletions.markItem(other.db, held.id, 0, "removed").state).toBe("pending");
    expect(
      teamDeletions
        .pending(f.db)
        .map((item) => item.id)
        .sort(),
    ).toEqual([record.id, held.id].sort());
    const orphan = randomUUID(),
      bare = fixture(f.db);
    rawInsert(bare, {}, { id: orphan });
    expect(() => teamDeletions.get(bare.db, orphan)).toThrow(/cleanup progress does not match its immutable inventory/);
    expect(() => bare.db.stmt("UPDATE team_deletions SET state='applied',updated_at=2 WHERE id=?").run(orphan)).toThrow(/confirm every cleanup item/);
    expect(() => bare.db.stmt("INSERT INTO team_deletion_items(deletion_id,item_index,state,updated_at) VALUES(?,0,'pending',0)").run(orphan)).toThrow(/mirror the immutable inventory/);
    bare.db.stmt("INSERT INTO team_deletion_items(deletion_id,item_index,state,updated_at) VALUES(?,0,'pending',1)").run(orphan);
    expect(teamDeletions.get(bare.db, orphan)?.items).toEqual([{ index: 0, state: "pending", updatedAt: 1 }]);
  });

  it("hides a retained owner only behind its exact fresh lead context, matching tasks and clear organisation flags", () => {
    const f = fixture(Db.memory(), 2),
      foreign = fixture(f.db);
    const stale = context(f.db, { id: "earlier", instanceId: f.instance.id, seed: f.input.seed }, { requestKey: "compact-earlier" });
    const record = teamDeletions.create(f.db, f.input);
    expect(() => teamDeletions.finish(f.db, record.id)).toThrow(/require their exact fresh context boundary/);
    for (const contextCheckpointId of ["missing", stale.id]) expect(() => teamDeletions.finish(f.db, record.id, { contextCheckpointId })).toThrow(/hidden owner marker requires/);
    for (const patch of [{ seed: "Different seed" }, { reason: "fresh_retry" as const, originExecutionId: f.execution.id }, { instanceId: foreign.instance.id }]) {
      expect(() => f.db.transaction(() => teamDeletions.finish(f.db, record.id, { contextCheckpointId: context(f.db, record, patch).id }))).toThrow(/hidden owner marker requires/);
    }
    for (const flag of flags) {
      threads.update(f.db, f.thread.id, { [flag]: 5 });
      expect(() => f.db.transaction(() => teamDeletions.finish(f.db, record.id, { contextCheckpointId: context(f.db, record).id }))).toThrow(/hidden owner marker requires/);
      threads.update(f.db, f.thread.id, { [flag]: null });
    }
    const late = tasks.insert(f.db, {
      projectId: f.project.id,
      threadId: f.thread.id,
      title: "Added later",
      spec: null,
      priority: "none",
      labels: [],
      workspaceMode: "worktree",
      baseRef: null,
      parentTaskId: null,
    });
    expect(() => f.db.transaction(() => teamDeletions.finish(f.db, record.id, { contextCheckpointId: context(f.db, record).id }))).toThrow(/match every current task/);
    tasks.delete(f.db, late.id);
    expect(teamContexts.listForInstance(f.db, f.instance.id)).toEqual([stale]);
    expect(teamDeletedThreads.list(f.db)).toEqual([]);
    expect(teamDeletions.get(f.db, record.id)).toEqual(record);
    const checkpoint = context(f.db, record);
    const applied = teamDeletions.finish(f.db, record.id, { contextCheckpointId: checkpoint.id });
    expect(applied).toMatchObject({ state: "applied", appliedContextId: checkpoint.id, error: null, items: [] });
    const marker = { threadId: f.thread.id, instanceId: f.instance.id, deletedAt: applied.updatedAt, contextCheckpointId: checkpoint.id, throughExecutionRowid: f.input.throughExecutionRowid };
    expect(teamDeletedThreads.get(f.db, f.thread.id)).toEqual(marker);
    expect(teamDeletedThreads.has(f.db, f.thread.id)).toBe(true);
    expect(teamDeletedThreads.has(f.db, foreign.thread.id)).toBe(false);
    expect(teamDeletedThreads.list(f.db)).toEqual([marker]);
    expect(teamDeletions.finish(f.db, record.id, { contextCheckpointId: checkpoint.id })).toEqual(applied);
    expect(() => teamDeletions.finish(f.db, record.id, { contextCheckpointId: stale.id })).toThrow(/applied with a different context/);
    expect(() => teamDeletions.finish(f.db, record.id)).toThrow(/applied with a different context/);
    expect(teamDeletions.create(f.db, f.input)).toEqual(applied);
    expect(() => teamDeletions.attention(f.db, record.id, "Late")).toThrow(/already applied/);
    expect(teamDeletions.pendingForThread(f.db, f.thread.id)).toEqual([]);
    expect(() => teamDeletions.create(f.db, { ...f.input, id: randomUUID(), requestKey: "again" })).toThrow(/deleted together/);
    expect(() => f.db.stmt("UPDATE team_deleted_threads SET deleted_at=0 WHERE thread_id=?").run(f.thread.id)).toThrow(/immutable/);
    expect(() => f.db.stmt("DELETE FROM team_deleted_threads WHERE thread_id=?").run(f.thread.id)).toThrow(/retained/);
    expect(() =>
      f.db
        .stmt("INSERT INTO team_deleted_threads(thread_id,instance_id,deleted_at,context_checkpoint_id,through_execution_rowid) VALUES(?,?,1,?,?)")
        .run(foreign.thread.id, foreign.instance.id, checkpoint.id, 0),
    ).toThrow(/hidden owner marker requires/);
    expect(() => f.db.stmt("UPDATE team_deletions SET state='pending',applied_context_id=NULL WHERE id=?").run(record.id)).toThrow(/immutable/);
    expect(() => f.db.stmt("UPDATE team_deletions SET updated_at=updated_at+1 WHERE id=?").run(record.id)).toThrow(/immutable/);
    expect(tasks.list(f.db, { threadId: f.thread.id }).map((task) => task.id)).toEqual(f.input.retainedTaskIds);
  });

  it("finishes a taskless deletion only after every item is removed and the owner row is gone, then survives the owner", () => {
    const f = fixture();
    const record = teamDeletions.create(f.db, f.input);
    expect(() => teamDeletions.finish(f.db, record.id)).toThrow(/every cleanup item must be confirmed removed/);
    teamDeletions.markItem(f.db, record.id, 0, "removed");
    expect(() => teamDeletions.finish(f.db, record.id)).toThrow(/must remove its owner/);
    expect(() => f.db.stmt("UPDATE team_deletions SET state='applied',updated_at=updated_at+1 WHERE id=?").run(record.id)).toThrow(/absent owner/);
    threads.delete(f.db, f.thread.id);
    expect(threads.get(f.db, f.thread.id)).toBeNull();
    expect(() => teamDeletions.finish(f.db, record.id, { contextCheckpointId: "any" })).toThrow(/must not create context/);
    expect(() => f.db.stmt("UPDATE team_deletions SET state='applied',applied_context_id='any',updated_at=updated_at+1 WHERE id=?").run(record.id)).toThrow(/CHECK|absent owner/);
    const applied = teamDeletions.finish(f.db, record.id);
    expect(applied).toMatchObject({ state: "applied", appliedContextId: null, error: null, items: [{ index: 0, state: "removed" }] });
    expect(teamDeletions.finish(f.db, record.id)).toEqual(applied);
    expect(() => teamDeletions.finish(f.db, record.id, { contextCheckpointId: "any" })).toThrow(/applied with a different context/);
    expect(teamDeletions.create(f.db, f.input)).toEqual(applied);
    expect(teamDeletions.find(f.db, f.thread.id, f.input.requestKey)).toEqual(applied);
    expect(teamDeletedThreads.has(f.db, f.thread.id)).toBe(false);
    expect(() => teamDeletions.markItem(f.db, record.id, 0, "quarantined")).toThrow(/already applied/);
    expect(() => f.db.stmt("UPDATE team_deletion_items SET state='quarantined' WHERE deletion_id=?").run(record.id)).toThrow(/only advances/);
    expect(() => f.db.stmt("INSERT INTO team_deletion_items(deletion_id,item_index,state,updated_at) VALUES(?,1,'pending',?)").run(record.id, Date.now())).toThrow(/mirror the immutable inventory/);
    expect(() => f.db.stmt("DELETE FROM team_deletions WHERE id=?").run(record.id)).toThrow(/retained independently/);
    const later = fixture(f.db);
    expect(() => teamDeletions.create(later.db, { ...later.input, entries: [entry(later.workspace, { canonicalPath: f.input.entries[0]!.canonicalPath })] })).toThrow(/only owned workspaces/);
    expect(f.db.stmt("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("excludes a hidden owner from every conversation surface while keeping it readable by id and unorganisable", () => {
    const f = fixture(Db.memory(), 1),
      visible = fixture(f.db);
    threads.update(f.db, f.thread.id, { prUrl: "https://example.test/pr/1" });
    messages.index(f.db, { runId: f.run.id, messageId: randomUUID(), role: "user", text: "Deleted conversation transcript", ts: 1 });
    const surfaces = () => ({
      all: ids(threads.list(f.db, { filter: "all" })),
      project: ids(threads.list(f.db, { projectId: f.project.id })),
      idle: ids(threads.idleSince(f.db, Date.now() + 1000)),
      pr: ids(threads.withOpenPr(f.db)),
      search: messages.search(f.db, "deleted conversation").map((hit) => hit.threadId),
    });
    expect(surfaces()).toEqual({
      all: expect.arrayContaining([f.thread.id, visible.thread.id]),
      project: [f.thread.id],
      idle: expect.arrayContaining([f.thread.id]),
      pr: [f.thread.id],
      search: [f.thread.id],
    });
    hide(f);
    expect(surfaces()).toEqual({ all: [visible.thread.id], project: [], idle: [visible.thread.id], pr: [], search: [] });
    for (const filter of ["active", "done", "archived", "all"] as const) expect(ids(threads.list(f.db, { filter, limit: 10 }))).not.toContain(f.thread.id);
    expect(threads.doneSince(f.db, Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(threads.dueFromSnooze(f.db, Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(threads.get(f.db, f.thread.id)).toMatchObject({ id: f.thread.id, prUrl: "https://example.test/pr/1", worktreePath: f.workspace });
    expect(tasks.list(f.db, { threadId: f.thread.id })).toHaveLength(1);
    for (const flag of flags) {
      expect(() => threads.update(f.db, f.thread.id, { [flag]: 5 })).toThrow(/cannot be organized/);
      expect(() => f.db.stmt(`UPDATE threads SET ${flag.replace(/[A-Z]/g, (letter) => "_" + letter.toLowerCase())}=5 WHERE id=?`).run(f.thread.id)).toThrow(/cannot be organized/);
      expect(threads.update(f.db, f.thread.id, { [flag]: null })[flag]).toBeNull();
      expect(threads.update(f.db, visible.thread.id, { [flag]: 5 })[flag]).toBe(5);
    }
    expect(threads.update(f.db, f.thread.id, { title: "Renamed", prUrl: null }).title).toBe("Renamed");
    threads.touch(f.db, f.thread.id);
    expect(ids(threads.list(f.db, { filter: "all" }))).toEqual([visible.thread.id]);
  });

  it("lets a hidden owner run only through an accepted request of one of its saved tasks and never fork, restore or move", () => {
    const f = fixture(Db.memory(), 1),
      foreign = fixture(f.db, 1),
      task = f.retained[0]!;
    intentFor(f, task.id);
    intentFor(foreign, foreign.retained[0]!.id);
    hide(f);
    const admission = teamTasks.createAdmission(f.db, admissionFor(f, task.id));
    const foreignAdmission = teamTasks.createAdmission(f.db, admissionFor(foreign, foreign.retained[0]!.id));
    expect(() => teamRuntime.create(f.db, freshExecution(f))).toThrow(/only runs through an accepted request of one of its saved tasks/);
    for (const requested of [
      { scope: "project" as const, requestKey: "task:" + admission.id },
      { scope: "thread" as const, requestKey: "task:" + randomUUID() },
      { scope: "thread" as const, requestKey: admission.id },
      { scope: "thread" as const, requestKey: "task:" + foreignAdmission.id },
    ]) {
      expect(() => teamRuntime.create(f.db, freshExecution(f, { ...requested, payloadHash: hash }))).toThrow(/only runs through an accepted request/);
    }
    expect(f.db.stmt("SELECT COUNT(*) AS n FROM team_executions WHERE thread_id=?").get(f.thread.id)).toEqual({ n: 1 });
    const started = teamRuntime.create(f.db, freshExecution(f, { scope: "thread", requestKey: "task:" + admission.id, payloadHash: hash }));
    expect(teamRuntime.get(f.db, started.id)).toEqual(started);
    expect(teamRuntime.create(foreign.db, freshExecution(foreign)).threadId).toBe(foreign.thread.id);
    expect(() => teamForks.create(f.db, forkInput(f))).toThrow(/deleted or deleting conversation cannot be forked/);
    expect(() => teamRestores.create(f.db, restoreInput(f))).toThrow(/deleted or deleting conversation cannot restore a checkpoint/);
    expect(() => teamMoves.create(f.db, moveInput(f))).toThrow(/deleted or deleting conversation cannot move its workspace/);
    expect(teamForks.list(f.db)).toEqual([]);
    expect(teamRestores.list(f.db)).toEqual([]);
    expect(teamMoves.list(f.db)).toEqual([]);
    expect(teamForks.create(f.db, { ...forkInput(foreign), destinationThreadId: randomUUID() }).sourceThreadId).toBe(foreign.thread.id);
  });

  it("fences new team work, admissions, context, forks, restores and moves while a deletion is retained, then releases them", () => {
    const f = fixture(Db.memory(), 1),
      task = f.retained[0]!;
    intentFor(f, task.id);
    const record = teamDeletions.create(f.db, f.input);
    const fenced = () => {
      expect(() => teamRuntime.create(f.db, freshExecution(f))).toThrow(/retained deletion before starting new team work/);
      expect(() => teamTasks.createAdmission(f.db, admissionFor(f, task.id))).toThrow(/retained deletion before accepting task work/);
      expect(() => context(f.db, record, { requestKey: "compact-now" })).toThrow(/retained deletion before changing team context/);
      expect(() => context(f.db, record, { requestKey: "delete:" + randomUUID() })).toThrow(/retained deletion before changing team context/);
      expect(() => teamForks.create(f.db, forkInput(f))).toThrow(/deleted or deleting conversation cannot be forked/);
      expect(() => teamRestores.create(f.db, restoreInput(f))).toThrow(/deleted or deleting conversation cannot restore a checkpoint/);
      expect(() => teamMoves.create(f.db, moveInput(f))).toThrow(/deleted or deleting conversation cannot move its workspace/);
    };
    fenced();
    teamDeletions.attention(f.db, record.id, "Interrupted before the marker");
    fenced();
    expect(teamContexts.listForInstance(f.db, f.instance.id)).toEqual([]);
    expect(teamTasks.admissions(f.db, task.id)).toEqual([]);
    const checkpoint = context(f.db, record);
    expect(checkpoint.requestKey).toBe("delete:" + record.id);
    const applied = teamDeletions.finish(f.db, record.id, { contextCheckpointId: checkpoint.id });
    expect(applied).toMatchObject({ state: "applied", error: null, appliedContextId: checkpoint.id });
    expect(teamTasks.createAdmission(f.db, admissionFor(f, task.id)).taskId).toBe(task.id);
    expect(context(f.db, record, { requestKey: "compact-now" }).epoch).toBe(2);
    const taskless = fixture(f.db),
      pending = teamDeletions.create(taskless.db, taskless.input);
    expect(() => teamRuntime.create(taskless.db, freshExecution(taskless))).toThrow(/retained deletion before starting new team work/);
    expect(() => context(taskless.db, pending, { requestKey: "compact-now", seed: "x" })).toThrow(/retained deletion before changing team context/);
    expect(context(taskless.db, pending, { seed: "Allowed while pending" }).requestKey).toBe("delete:" + pending.id);
  });

  it("applies migration 22 over a version 21 ledger, keeps existing rows and retains receipts and markers through reopen", () => {
    const folder = mkdtempSync(join(tmpdir(), "openorc-deletion-journal-"));
    folders.push(folder);
    const file = join(folder, "fixture.sqlite"),
      raw = new DatabaseSync(file),
      prior = migrations.indexOf(teamDeleteMigration);
    expect(prior).toBe(21);
    for (const migration of migrations.slice(0, prior)) typeof migration === "string" ? raw.exec(migration) : migration(raw);
    raw.exec("PRAGMA user_version=" + prior);
    const old = new Db(raw),
      f = fixture(old, 1),
      bare = fixture(old);
    const before = context(old, { id: "pre-upgrade", instanceId: f.instance.id, seed: "Retain checkpoint" }, { requestKey: "pre-upgrade" });
    expect(() => old.stmt("SELECT 1 FROM team_deletions").get()).toThrow(/no such table/);
    old.close();
    opened.delete(old);
    const db = Db.open(file);
    opened.add(db);
    expect(db.version).toBe(migrations.length);
    expect(teamContexts.get(db, before.id)).toEqual(before);
    expect(teamRuntime.get(db, f.execution.id)).toEqual(f.execution);
    expect(threads.get(db, f.thread.id)).toEqual({ ...f.thread, workingDirectory: null });
    expect(ids(threads.list(db, { filter: "all" })).sort()).toEqual([f.thread.id, bare.thread.id].sort());
    const { record: hidden, checkpoint } = hide({ ...f, db });
    const taskless = teamDeletions.create(db, bare.input);
    teamDeletions.markItem(db, taskless.id, 0, "quarantined");
    const interrupted = teamDeletions.attention(db, taskless.id, "Removal interrupted");
    const rejected = teamDeletions.reject(db, { threadId: bare.thread.id, requestKey: "denied", requestHash: "b".repeat(64), error: "Unsupported workspace" });
    db.close();
    opened.delete(db);
    const reopened = Db.open(file);
    opened.add(reopened);
    expect(teamDeletions.get(reopened, hidden.id)).toEqual(hidden);
    expect(teamDeletedThreads.get(reopened, f.thread.id)).toMatchObject({ instanceId: f.instance.id, contextCheckpointId: checkpoint.id, throughExecutionRowid: f.input.throughExecutionRowid });
    expect(ids(threads.list(reopened, { filter: "all" }))).toEqual([bare.thread.id]);
    expect(teamDeletions.finish(reopened, hidden.id, { contextCheckpointId: checkpoint.id })).toEqual(hidden);
    expect(teamDeletions.get(reopened, taskless.id)).toEqual(interrupted);
    threads.delete(reopened, bare.thread.id);
    teamDeletions.markItem(reopened, taskless.id, 0, "removed");
    expect(teamDeletions.finish(reopened, taskless.id)).toMatchObject({ state: "applied", error: null });
    expect(teamDeletions.rejection(reopened, bare.thread.id, "denied")).toEqual(rejected);
    expect(
      teamDeletions
        .list(reopened)
        .map((item) => item.id)
        .sort(),
    ).toEqual([hidden.id, taskless.id].sort());
    expect(teamDeletions.pending(reopened)).toEqual([]);
    expect(reopened.stmt("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
