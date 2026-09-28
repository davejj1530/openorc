import { insertLegacyRun } from "./fixtures/legacy-run.js";
import { teamJournalWriter } from "./fixtures/legacy-team-journal.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TEAM_LIMITS, MAX_TEAM_CONTEXT_BYTES } from "@openorc/protocol";
import { Db } from "./database.js";
import { migrations } from "./schema.js";
import { orchestration } from "./orchestration.js";
import { insertLegacyCheckpoint } from "./fixtures/legacy-checkpoint.js";
import { projects, runs, threads } from "./repos.js";
import { teamRuntime } from "./team-runtime.js";
import { teamContexts } from "./team-context.js";
import { teamRestores, type CreateTeamRestoreInput, type TeamRestoreRecord } from "./team-restores.js";
import { teamRestoreMigration } from "./team-restore-schema.js";

const opened = new Set<Db>(),
  folders: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of opened) db.close();
  opened.clear();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const settings = { agent: "codex" as const, model: "fixture", effort: "high", fastMode: false };
function fixture(db = Db.memory()) {
  opened.add(db);
  const project = projects.insert(db, { name: "Restore journal", rootPath: "/tmp/" + randomUUID(), defaultBranch: "main", gitRemote: null, settings: {} });
  const saved = orchestration.save(db, {
    projectId: project.id,
    expectedRevisionId: null,
    draft: { name: "Restore team", limits: DEFAULT_TEAM_LIMITS, members: [{ key: "lead", name: "Lead", managerKey: null, responsibility: "Work", settings }] },
  });
  const thread = threads.insert(db, { projectId: project.id, title: "Retain workspace", ...settings, mode: "act", permissionMode: "review", workspaceMode: "worktree" });
  const sourcePath = "/tmp/team-workspaces/" + randomUUID();
  threads.update(db, thread.id, { worktreePath: sourcePath, baseSha: "1".repeat(40), branch: "openorc/team-" + thread.id });
  const instance = orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: saved.revision.id });
  const olderRun = insertLegacyRun(db, { id: randomUUID(), threadId: thread.id, taskId: null, ...settings, mode: "act", permissionMode: "review" });
  runs.update(db, olderRun.id, { state: "success", endedAt: 10 });
  const checkpoint = insertLegacyCheckpoint(db, { threadId: thread.id, runId: olderRun.id, turn: 1, treeSha: "2".repeat(40), diffStat: { files: 1, insertions: 1, deletions: 0, untracked: 0 } });
  const run = insertLegacyRun(db, { id: randomUUID(), threadId: thread.id, taskId: null, ...settings, mode: "act", permissionMode: "review" });
  runs.update(db, run.id, { state: "success", endedAt: 100 });
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
        input: { title: "Restore work", spec: "Original instructions", attachments: [], responsibility: "Work", settings },
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
  const input: CreateTeamRestoreInput = {
    id: randomUUID(),
    threadId: thread.id,
    instanceId: instance.id,
    projectId: project.id,
    projectRoot: project.rootPath,
    requestKey: "restore-once",
    requestHash: "a".repeat(64),
    checkpointId: checkpoint.id,
    sourceRunId: run.id,
    sourcePath,
    targetTree: checkpoint.treeSha,
    setupInput: null,
    seed: "Original instructions and replies through selected checkpoint",
    before: {
      rootPath: "/private" + sourcePath,
      headSha: "1".repeat(40),
      treeSha: "3".repeat(40),
      branch: null,
      treeRef: "refs/openorc/restores/fixture/before/tree",
      headRef: "refs/openorc/restores/fixture/before/head",
      indexSha256: "4".repeat(64),
    },
  };
  return { db, project, thread: threads.get(db, thread.id)!, instance, olderRun, run, checkpoint, execution, input };
}
function context(db: Db, record: TeamRestoreRecord, patch: Partial<Parameters<typeof teamContexts.create>[1]> = {}) {
  return teamContexts.create(db, {
    instanceId: record.instanceId,
    executionId: null,
    actorId: "lead",
    originExecutionId: null,
    reason: "compact",
    requestKey: "restore:" + record.id,
    seed: record.seed,
    ...patch,
  });
}
function apply(db: Db, record: TeamRestoreRecord, candidate: string) {
  return db.transaction(() => {
    const checkpoint = context(db, record);
    threads.update(db, record.threadId, { worktreePath: candidate, baseSha: record.before.headSha });
    return teamRestores.apply(db, record.id, { path: candidate, contextCheckpointId: checkpoint.id });
  });
}

describe("durable team checkpoint restore manifests", () => {
  it("refuses a structurally valid SQL recovery row with a malformed captured tree", () => {
    const { db, input } = fixture();
    const good = teamRestores.create(db, input);
    const row = db.stmt("SELECT captured_input FROM team_restores WHERE id=?").get(good.id) as { captured_input: string };
    const capture = { ...JSON.parse(row.captured_input), before: null };
    const malformedId = randomUUID();
    db.stmt("INSERT INTO team_restores(id,thread_id,instance_id,project_id,request_key,request_hash,captured_input,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'pending',1,1)").run(
      malformedId,
      input.threadId,
      input.instanceId,
      input.projectId,
      "malformed-tree",
      input.requestHash,
      JSON.stringify(capture),
    );
    expect(() => teamRestores.get(db, malformedId)).toThrow(`Restore recovery intent ${malformedId} could not be read. Preserve the database for recovery.`);
    expect(teamRestores.get(db, good.id)).toEqual(good);
  });

  it("retains exact terminal rejections and never admits the same rejected request later", () => {
    const { db, input } = fixture();
    const rejected = { threadId: input.threadId, requestKey: input.requestKey, requestHash: input.requestHash, error: "This checkpoint lacks an exact retained tree." };
    expect(teamRestores.rejection(db, input.threadId, input.requestKey)).toBeNull();
    expect(() =>
      db.transaction(() => {
        teamRestores.reject(db, rejected);
        throw Error("rollback");
      }),
    ).toThrow(/rollback/);
    expect(teamRestores.rejection(db, input.threadId, input.requestKey)).toBeNull();
    const receipt = teamRestores.reject(db, rejected);
    expect(teamRestores.reject(db, rejected)).toEqual(receipt);
    expect(teamRestores.rejection(db, input.threadId, input.requestKey)).toEqual(receipt);
    for (const patch of [{ requestHash: "b".repeat(64) }, { error: "A different rejection" }]) {
      expect(() => teamRestores.reject(db, { ...rejected, ...patch })).toThrow(/different rejection/);
    }
    expect(() => teamRestores.create(db, input)).toThrow(/rejected and cannot later be admitted/);
    expect(() => db.stmt("UPDATE team_restore_rejections SET error='changed' WHERE thread_id=? AND request_key=?").run(input.threadId, input.requestKey)).toThrow(/immutable/);
    expect(() => db.stmt("DELETE FROM team_restore_rejections WHERE thread_id=?").run(input.threadId)).toThrow(/retained/);
    expect(teamRestores.find(db, input.threadId, input.requestKey)).toBeNull();
    expect(teamRestores.pendingForThread(db, input.threadId)).toEqual([]);
  });

  it("rejects malformed rejection keys and cannot reject an already admitted request through repository or SQL", () => {
    const { db, input } = fixture();
    const rejected = { threadId: input.threadId, requestKey: input.requestKey, requestHash: input.requestHash, error: "Unavailable" };
    for (const patch of [{ threadId: "" }, { requestKey: "" }, { requestKey: "x".repeat(201) }, { requestHash: "bad" }, { error: " " }]) {
      expect(() => teamRestores.reject(db, { ...rejected, ...patch })).toThrow(/bounded request identity/);
    }
    const admitted = teamRestores.create(db, input);
    expect(() => teamRestores.reject(db, rejected)).toThrow(/admitted restore request cannot be rejected/);
    expect(() =>
      db.stmt("INSERT INTO team_restore_rejections(thread_id,request_key,request_hash,error,created_at) VALUES(?,?,?,?,?)").run(input.threadId, input.requestKey, input.requestHash, "Raw attempt", 1),
    ).toThrow(/admitted restore request cannot be rejected/);
    expect(teamRestores.get(db, admitted.id)).toEqual(admitted);
    expect(teamRestores.rejection(db, input.threadId, input.requestKey)).toBeNull();
    const another = teamRestores.reject(db, { ...rejected, requestKey: "another-request" });
    expect(another.requestKey).toBe("another-request");
  });

  it("pins exact request data and accepts a source attempt referencing an earlier no-change checkpoint", () => {
    const { db, input, checkpoint, run } = fixture();
    expect(checkpoint.runId).not.toBe(run.id);
    const record = teamRestores.create(db, input);
    expect(teamRestores.create(db, input)).toEqual(record);
    expect(teamRestores.find(db, input.threadId, input.requestKey)).toEqual(record);
    expect(teamRestores.pendingForThread(db, input.threadId)).toEqual([record]);
    expect(teamRestores.latestForThread(db, input.threadId)).toBeNull();
    for (const patch of [
      { seed: "Changed context" },
      { requestHash: "b".repeat(64) },
      { checkpointId: "changed" },
      { sourceRunId: null },
      { targetTree: "f".repeat(40) },
      { before: { ...input.before, treeSha: "5".repeat(40) } },
      { setupInput: { ...input.before, treeSha: "6".repeat(40) } },
    ]) {
      expect(() => teamRestores.create(db, { ...input, ...patch })).toThrow(/different captured work/);
    }
    expect(() => db.stmt("UPDATE team_restores SET captured_input=json_set(captured_input,'$.seed','changed') WHERE id=?").run(record.id)).toThrow(/immutable/);
    expect(() => db.stmt("UPDATE team_restores SET request_hash=? WHERE id=?").run("b".repeat(64), record.id)).toThrow(/immutable/);
  });

  it("requires the current workspace, exact checkpoint tree and source lead attempt ownership", () => {
    const { db, input, olderRun, thread } = fixture(),
      foreign = fixture(db);
    const another = insertLegacyCheckpoint(db, { threadId: thread.id, runId: olderRun.id, turn: 2, treeSha: "7".repeat(40), diffStat: { files: 1, insertions: 2, deletions: 0, untracked: 0 } });
    for (const patch of [
      { threadId: foreign.thread.id },
      { instanceId: foreign.instance.id },
      { projectId: foreign.project.id },
      { projectRoot: "/tmp/wrong" },
      { checkpointId: foreign.checkpoint.id },
      { targetTree: "f".repeat(40) },
      { sourceRunId: foreign.run.id },
      { sourceRunId: olderRun.id },
      { checkpointId: another.id, targetTree: another.treeSha },
      { sourcePath: "/tmp/stale" },
    ]) {
      expect(() => teamRestores.create(db, { ...input, ...patch })).toThrow(/exact owned checkpoint/);
    }
    expect(() => teamRestores.create(db, { ...input, setupInput: { ...input.before, rootPath: "relative" } })).toThrow(/absolute snapshot/);
    expect(teamRestores.list(db)).toEqual([]);
    expect(teamRestores.create(db, { ...input, sourceRunId: null }).sourceRunId).toBeNull();
  });

  it("retains every candidate, forbids in-place restore and requires a new path after interruption", () => {
    const { db, input } = fixture();
    const initial = teamRestores.create(db, input);
    for (const candidate of [input.sourcePath, input.projectRoot]) expect(() => teamRestores.appendPath(db, initial.id, candidate)).toThrow(/preserve the original/);
    for (const candidate of ["relative", "/tmp/a/../b"]) expect(() => teamRestores.appendPath(db, initial.id, candidate)).toThrow(/normalized absolute/);
    teamRestores.appendPath(db, initial.id, "/tmp/restore-first");
    teamRestores.attention(db, initial.id, "Interrupted before receipt");
    const record = teamRestores.appendPath(db, initial.id, "/tmp/restore-second");
    expect(record).toMatchObject({ state: "attention", error: "Interrupted before receipt", paths: ["/tmp/restore-first", "/tmp/restore-second"] });
    expect(() => teamRestores.appendPath(db, initial.id, "/tmp/restore-first")).toThrow(/new path/);
    const second = teamRestores.create(db, { ...input, id: randomUUID(), requestKey: "another-restore" });
    expect(() => teamRestores.appendPath(db, second.id, "/tmp/restore-first")).toThrow(/new path/);
    for (const paths of [[], [record.paths[1]], [...record.paths].reverse(), [...record.paths, "/tmp/a", "/tmp/b"], [...record.paths, record.paths[0]], [...record.paths, input.sourcePath]]) {
      expect(() => db.stmt("UPDATE team_restores SET paths=? WHERE id=?").run(JSON.stringify(paths), initial.id)).toThrow(/immutable/);
    }
    expect(() => db.stmt("UPDATE team_restores SET state='pending',error=NULL WHERE id=?").run(initial.id)).toThrow(/immutable/);
    expect(() => db.stmt("DELETE FROM team_restores WHERE id=?").run(initial.id)).toThrow(/retained/);
    expect(teamRestores.get(db, initial.id)).toEqual(record);
  });

  it("atomically applies only the latest candidate with exact context, keeping HEAD and publication branch", () => {
    const { db, input, thread } = fixture();
    const record = teamRestores.create(db, input);
    teamRestores.appendPath(db, record.id, "/tmp/restore-old");
    teamRestores.appendPath(db, record.id, "/tmp/restore-new");
    expect(() => teamRestores.apply(db, record.id, { path: "/tmp/restore-old", contextCheckpointId: "missing" })).toThrow(/newest/);
    expect(() => teamRestores.apply(db, record.id, { path: "/tmp/restore-new", contextCheckpointId: "missing" })).toThrow(/replacement context/);
    expect(() =>
      db.transaction(() => {
        apply(db, record, "/tmp/restore-new");
        throw Error("outer rollback");
      }),
    ).toThrow(/outer rollback/);
    expect(threads.get(db, thread.id)).toEqual(thread);
    expect(teamContexts.listForInstance(db, record.instanceId)).toEqual([]);
    expect(teamRestores.get(db, record.id)?.state).toBe("pending");
    const applied = apply(db, record, "/tmp/restore-new");
    expect(applied).toMatchObject({ state: "applied", appliedPath: "/tmp/restore-new", error: null });
    expect(threads.get(db, thread.id)).toMatchObject({ worktreePath: applied.appliedPath, baseSha: record.before.headSha, branch: thread.branch });
    expect(teamRestores.latestForThread(db, thread.id)).toEqual(applied);
    expect(teamRestores.pendingForThread(db, thread.id)).toEqual([]);
    expect(teamRestores.apply(db, applied.id, { path: applied.appliedPath!, contextCheckpointId: applied.appliedContextId! })).toEqual(applied);
    expect(teamContexts.listForInstance(db, record.instanceId)).toHaveLength(1);
    expect(() => teamRestores.apply(db, applied.id, { path: applied.appliedPath!, contextCheckpointId: "different" })).toThrow(/different workspace or context/);
    expect(() => teamRestores.attention(db, applied.id, "Late error")).toThrow(/already applied/);
    expect(() => teamRestores.appendPath(db, applied.id, "/tmp/restore-late")).toThrow(/already applied/);
    expect(() => db.stmt("UPDATE team_restores SET state='attention',applied_path=NULL,applied_context_id=NULL,error='late' WHERE id=?").run(applied.id)).toThrow(/immutable/);
  });

  it("rejects wrong project, workspace pointer, HEAD or context without consuming the retained intent", () => {
    const { db, input, execution, thread } = fixture(),
      foreign = fixture(db);
    const record = teamRestores.create(db, input),
      candidate = "/tmp/restore-malformed";
    const pending = teamRestores.appendPath(db, record.id, candidate);
    for (const patch of [{ seed: "Wrong seed" }, { requestKey: "compact-unrelated" }, { instanceId: foreign.instance.id }, { reason: "fresh_retry" as const, originExecutionId: execution.id }]) {
      expect(() =>
        db.transaction(() => {
          const reset = context(db, record, patch);
          threads.update(db, record.threadId, { worktreePath: candidate, baseSha: record.before.headSha });
          teamRestores.apply(db, record.id, { path: candidate, contextCheckpointId: reset.id });
        }),
      ).toThrow(/replacement context/);
    }
    for (const patch of [{ worktreePath: "/tmp/different" }, { baseSha: "f".repeat(40) }, { workspaceMode: "current" as const }]) {
      expect(() =>
        db.transaction(() => {
          const reset = context(db, record);
          threads.update(db, record.threadId, { worktreePath: candidate, baseSha: record.before.headSha, ...patch });
          teamRestores.apply(db, record.id, { path: candidate, contextCheckpointId: reset.id });
        }),
      ).toThrow(/replacement context/);
    }
    expect(() =>
      db.transaction(() => {
        const reset = context(db, record);
        threads.update(db, record.threadId, { worktreePath: candidate, baseSha: record.before.headSha });
        db.stmt("UPDATE projects SET root_path='/tmp/moved-project' WHERE id=?").run(record.projectId);
        teamRestores.apply(db, record.id, { path: candidate, contextCheckpointId: reset.id });
      }),
    ).toThrow(/replacement context/);
    expect(teamRestores.get(db, record.id)).toEqual(pending);
    expect(threads.get(db, thread.id)).toEqual(thread);
    expect(teamContexts.listForInstance(db, record.instanceId)).toEqual([]);
    expect(db.stmt("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rejects direct ownership bypass and enforces UTF-8 seed bounds", () => {
    const { db, input } = fixture();
    expect(() => teamRestores.create(db, { ...input, seed: "🧠".repeat(MAX_TEAM_CONTEXT_BYTES / 4 + 1) })).toThrow(/UTF-8/);
    const record = teamRestores.create(db, input);
    const row = db.stmt("SELECT captured_input FROM team_restores WHERE id=?").get(record.id) as { captured_input: string };
    const capture = JSON.parse(row.captured_input) as Record<string, unknown>;
    const insert = (captured: Record<string, unknown>) =>
      db
        .stmt("INSERT INTO team_restores (id,thread_id,instance_id,project_id,request_key,request_hash,captured_input,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'pending',1,1)")
        .run(randomUUID(), input.threadId, input.instanceId, input.projectId, randomUUID(), input.requestHash, JSON.stringify(captured));
    for (const patch of [{ checkpointId: "foreign" }, { targetTree: "f".repeat(40) }, { sourcePath: "/tmp/stale" }, { sourceRunId: "foreign" }]) {
      expect(() => insert({ ...capture, ...patch })).toThrow(/exact owned checkpoint/);
    }
    expect(() => insert({ ...capture, seed: "é".repeat(MAX_TEAM_CONTEXT_BYTES) })).toThrow(/CHECK/);
    expect(teamRestores.list(db)).toEqual([record]);
  });

  it("selects the latest applied context despite clock skew and excludes unrelated or incomplete recovery", () => {
    const { db, input } = fixture();
    const first = teamRestores.create(db, input);
    teamRestores.appendPath(db, first.id, "/tmp/restored-first");
    apply(db, first, "/tmp/restored-first");
    const clock = vi.spyOn(Date, "now").mockReturnValue(first.createdAt - 1000);
    const secondInput = { ...input, id: randomUUID(), requestKey: "restore-second", sourcePath: "/tmp/restored-first", before: { ...input.before, rootPath: "/tmp/restored-first" } };
    const second = teamRestores.create(db, secondInput);
    teamRestores.appendPath(db, second.id, "/tmp/restored-second");
    const applied = apply(db, second, "/tmp/restored-second");
    expect(applied.updatedAt).toBeLessThan(first.createdAt);
    clock.mockRestore();
    const pending = teamRestores.create(db, {
      ...secondInput,
      id: randomUUID(),
      requestKey: "restore-third",
      sourcePath: "/tmp/restored-second",
      before: { ...input.before, rootPath: "/tmp/restored-second" },
    });
    teamRestores.attention(db, pending.id, "Not applied");
    const foreign = fixture(db);
    teamRestores.create(db, foreign.input);
    expect(teamRestores.latestForThread(db, input.threadId)).toEqual(applied);
    expect(
      teamRestores
        .forThread(db, input.threadId)
        .map((item) => item.id)
        .sort(),
    ).toEqual([first.id, second.id, pending.id].sort());
    expect(
      teamContexts
        .listForInstance(db, input.instanceId)
        .map((item) => item.epoch)
        .sort(),
    ).toEqual([1, 2]);
  });

  it("migrates existing history and retains applied/interrupted manifests through owner deletion and reopen", () => {
    const folder = mkdtempSync(join(tmpdir(), "openorc-restore-journal-"));
    folders.push(folder);
    const file = join(folder, "fixture.sqlite"),
      raw = new DatabaseSync(file),
      prior = migrations.indexOf(teamRestoreMigration);
    expect(prior).toBeGreaterThan(0);
    for (const migration of migrations.slice(0, prior)) typeof migration === "string" ? raw.exec(migration) : migration(raw);
    raw.exec("PRAGMA user_version=" + prior);
    const old = new Db(raw),
      f = fixture(old);
    old.close();
    opened.delete(old);
    const db = Db.open(file);
    opened.add(db);
    expect(teamRuntime.get(db, f.execution.id)).toEqual(f.execution);
    f.input.setupInput = { ...f.input.before, treeSha: "5".repeat(40), treeRef: "refs/openorc/restores/fixture/setup/tree" };
    const record = teamRestores.create(db, f.input);
    teamRestores.appendPath(db, record.id, "/tmp/restored-retained");
    const applied = apply(db, record, "/tmp/restored-retained");
    const pending = teamRestores.create(db, {
      ...f.input,
      id: randomUUID(),
      requestKey: "interrupted",
      sourcePath: applied.appliedPath!,
      before: { ...f.input.before, rootPath: applied.appliedPath! },
      setupInput: null,
    });
    teamRestores.appendPath(db, pending.id, "/tmp/restore-interrupted");
    teamRestores.attention(db, pending.id, "Preserve this directory");
    const rejectedInput = { threadId: f.thread.id, requestKey: "rejected-before-admission", requestHash: "b".repeat(64), error: "Unsupported checkpoint" };
    const rejected = teamRestores.reject(db, rejectedInput);
    db.stmt("DELETE FROM projects WHERE id=?").run(f.project.id);
    db.close();
    opened.delete(db);
    const reopened = Db.open(file);
    opened.add(reopened);
    expect(teamRestores.apply(reopened, applied.id, { path: applied.appliedPath!, contextCheckpointId: applied.appliedContextId! })).toEqual(applied);
    expect(teamRestores.create(reopened, f.input)).toEqual(applied);
    expect(teamRestores.get(reopened, applied.id)?.setupInput).toEqual(f.input.setupInput);
    expect(teamRestores.get(reopened, pending.id)).toMatchObject({ state: "attention", paths: ["/tmp/restore-interrupted"] });
    expect(teamRestores.list(reopened)).toHaveLength(2);
    expect(teamRestores.latestForThread(reopened, f.thread.id)).toEqual(applied);
    expect(teamContexts.get(reopened, applied.appliedContextId!)).toBeNull();
    expect(teamRestores.rejection(reopened, f.thread.id, rejectedInput.requestKey)).toEqual(rejected);
    expect(teamRestores.reject(reopened, rejectedInput)).toEqual(rejected);
    expect(() => teamRestores.reject(reopened, { ...rejectedInput, requestHash: "c".repeat(64) })).toThrow(/different rejection/);
    expect(reopened.stmt("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
