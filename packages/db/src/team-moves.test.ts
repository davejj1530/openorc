import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TEAM_LIMITS, type TeamTreeCapture } from "@openorc/protocol";
import { Db } from "./database.js";
import { migrations } from "./schema.js";
import { orchestration } from "./orchestration.js";
import { projects, threads } from "./repos.js";
import { teamContexts } from "./team-context.js";
import { checkpoints } from "./checkpoints.js";
import { teamRestores } from "./team-restores.js";
import { teamMoves, type CreateTeamMoveInput, type TeamMoveRecord } from "./team-moves.js";

const opened = new Set<Db>(),
  folders: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of opened) db.close();
  opened.clear();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const settings = { agent: "codex" as const, model: "fixture", effort: "high", fastMode: false };
const sha = (value: string) => value.repeat(40);
function snapshot(rootPath: string, head = "1", tree = "2"): TeamTreeCapture {
  return { rootPath, headSha: sha(head), treeSha: sha(tree), branch: null, treeRef: "refs/openorc/tests/tree", headRef: "refs/openorc/tests/head", indexSha256: "3".repeat(64) };
}
function fixture(db = Db.memory()) {
  opened.add(db);
  const project = projects.insert(db, { name: "Move journal", rootPath: `/tmp/${randomUUID()}`, defaultBranch: "main", gitRemote: null, settings: {} });
  const team = orchestration.save(db, {
    projectId: project.id,
    expectedRevisionId: null,
    draft: { name: "Move team", limits: DEFAULT_TEAM_LIMITS, members: [{ key: "lead", name: "Lead", managerKey: null, responsibility: "Work", settings }] },
  });
  const sourcePath = `${project.rootPath}-isolated`;
  let thread = threads.insert(db, { projectId: project.id, title: "Move this team", ...settings, mode: "act", permissionMode: "review", workspaceMode: "worktree" });
  const publicationBranch = `openorc/team-${thread.id}`;
  thread = threads.update(db, thread.id, { worktreePath: sourcePath, baseSha: sha("1"), branch: publicationBranch });
  const instance = orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: team.revision.id });
  const input: CreateTeamMoveInput = {
    id: randomUUID(),
    threadId: thread.id,
    instanceId: instance.id,
    projectId: project.id,
    projectRoot: project.rootPath,
    requestKey: "move-once",
    requestHash: "a".repeat(64),
    from: "worktree",
    to: "current",
    sourcePath,
    source: snapshot(`/private${sourcePath}`),
    setupInput: null,
    destinationBefore: snapshot(`/private${project.rootPath}`, "4", "5"),
    deltas: [{ baseTree: sha("6"), outputTree: sha("2") }],
    originMoveId: null,
    publicationBranch,
    seed: "Preserve canonical move requirements",
  };
  return { db, project, thread, team, instance, input };
}
function plan(db: Db, record: TeamMoveRecord, tree = "7") {
  return teamMoves.plan(db, record.id, {
    afterTree: sha(tree),
    entries: [{ path: "file.txt", before: { path: "file.txt", mode: "100644", oid: sha("8") }, after: { path: "file.txt", mode: "100755", oid: sha("9") } }],
  });
}
function apply(db: Db, record: TeamMoveRecord, target = record.projectRoot) {
  return db.transaction(() => {
    threads.update(db, record.threadId, {
      workspaceMode: record.to,
      worktreePath: record.to === "current" ? null : target,
      baseSha: record.destinationBefore?.headSha ?? record.source.headSha,
      branch: record.publicationBranch,
    });
    const context = teamContexts.create(db, {
      instanceId: record.instanceId,
      executionId: null,
      actorId: "lead",
      originExecutionId: null,
      reason: "compact",
      requestKey: `move:${record.id}`,
      seed: record.seed,
    });
    return teamMoves.apply(db, record.id, { path: target, contextCheckpointId: context.id });
  });
}
function returnInput(record: TeamMoveRecord): CreateTeamMoveInput {
  return {
    id: randomUUID(),
    threadId: record.threadId,
    instanceId: record.instanceId,
    projectId: record.projectId,
    projectRoot: record.projectRoot,
    requestKey: "return-isolated",
    requestHash: "b".repeat(64),
    from: "current",
    to: "worktree",
    sourcePath: record.projectRoot,
    source: snapshot(`/private${record.projectRoot}`, "4", "7"),
    setupInput: null,
    destinationBefore: null,
    deltas: record.deltas,
    originMoveId: record.id,
    publicationBranch: record.publicationBranch,
    seed: "Retained return requirements",
  };
}

describe("durable team workspace moves", () => {
  it("retains immutable captured inputs, idempotent requests and one unfinished move per thread", () => {
    const { db, input } = fixture(),
      record = teamMoves.create(db, input);
    expect(record).toMatchObject({ state: "pending", publication: null, afterTree: null, cancelRequested: false, paths: [] });
    expect(teamMoves.create(db, input)).toEqual(record);
    expect(teamMoves.find(db, input.threadId, input.requestKey)).toEqual(record);
    expect(teamMoves.pendingForThread(db, input.threadId)).toEqual([record]);
    for (const patch of [{ requestHash: "c".repeat(64) }, { seed: "Changed" }, { sourcePath: "/tmp/different" }, { deltas: [] }, { publicationBranch: null }])
      expect(() => teamMoves.create(db, { ...input, ...patch })).toThrow(/different captured work/);
    expect(() => teamMoves.create(db, { ...input, id: randomUUID(), requestKey: "concurrent" })).toThrow(/UNIQUE/);
    expect(() => db.stmt("UPDATE team_moves SET captured_input=json_set(captured_input,'$.seed','changed') WHERE id=?").run(record.id)).toThrow(/immutable/);
    expect(() => db.stmt("DELETE FROM team_moves WHERE id=?").run(record.id)).toThrow(/retained/);
  });

  it("rejects foreign owners, wrong source pointers and invalid captures before admission", () => {
    const f = fixture(),
      foreign = fixture(f.db);
    for (const patch of [{ threadId: foreign.thread.id }, { instanceId: foreign.instance.id }, { projectId: foreign.project.id }, { projectRoot: "/tmp/wrong" }, { sourcePath: "/tmp/wrong" }])
      expect(() => teamMoves.create(f.db, { ...f.input, ...patch })).toThrow(/current team/);
    for (const patch of [
      { from: "current" as const },
      { destinationBefore: null },
      { originMoveId: "foreign" },
      { deltas: [{ baseTree: "invalid", outputTree: sha("2") }] },
      { setupInput: snapshot("/tmp/wrong") },
    ])
      expect(() => teamMoves.create(f.db, { ...f.input, ...patch })).toThrow();
    expect(teamMoves.list(f.db)).toEqual([]);
  });

  it("rejects an initial local move without a retained workspace, including direct SQL insertion", () => {
    const { db, input, thread } = fixture();
    threads.update(db, thread.id, { workspaceMode: "current", worktreePath: null });
    const local = { ...input, from: "current" as const, to: "worktree" as const, sourcePath: input.projectRoot, destinationBefore: null };
    expect(() => teamMoves.create(db, local)).toThrow(/retained checkout workspace/);
    expect(() =>
      db
        .stmt("INSERT INTO team_moves(id,thread_id,instance_id,project_id,request_key,request_hash,captured_input,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'pending',1,1)")
        .run(local.id, local.threadId, local.instanceId, local.projectId, local.requestKey, local.requestHash, JSON.stringify(local)),
    ).toThrow(/current team/);
  });

  it("upgrades populated move journals without changing receipts, order or retained guards", () => {
    const folder = mkdtempSync(join(tmpdir(), "openorc-local-migration-"));
    folders.push(folder);
    const file = join(folder, "fixture.sqlite"),
      raw = new DatabaseSync(file);
    for (const migration of migrations.slice(0, -1)) typeof migration === "string" ? raw.exec(migration) : migration(raw);
    raw.exec(`PRAGMA user_version=${migrations.length - 1}`);
    const old = new Db(raw),
      f = fixture(old);
    const applied = apply(old, plan(old, teamMoves.create(old, f.input)));
    const pending = teamMoves.create(old, returnInput(applied));
    const retained = teamMoves.attention(old, pending.id, "Keep recovery evidence");
    const guards = old.stmt("SELECT name FROM sqlite_master WHERE type='trigger' AND instr(sql,'team_moves')>0 ORDER BY name").all();
    old.close();
    opened.delete(old);
    const upgraded = Db.open(file);
    opened.add(upgraded);
    expect(teamMoves.forThread(upgraded, f.thread.id)).toEqual([applied, retained]);
    expect(upgraded.stmt("SELECT name FROM sqlite_master WHERE type='trigger' AND instr(sql,'team_moves')>0 ORDER BY name").all()).toEqual(guards);
    expect(() => upgraded.stmt("DELETE FROM team_moves WHERE id=?").run(applied.id)).toThrow(/retained/);
    expect(upgraded.stmt("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("retains unique append-only candidates and an immutable exact publication plan", () => {
    const { db, input } = fixture(),
      other = fixture(db),
      record = teamMoves.create(db, input);
    teamMoves.appendPath(db, record.id, { path: "/tmp/merge-one", kind: "scratch" });
    expect(() => teamMoves.appendPath(db, record.id, { path: input.sourcePath, kind: "scratch" })).toThrow(/separate/);
    expect(() => teamMoves.appendPath(db, record.id, { path: "/tmp/illegal-workspace", kind: "workspace" })).toThrow(/correct role/);
    expect(() => teamMoves.appendPath(db, record.id, { path: "/tmp/merge-one", kind: "scratch" })).toThrow(/new path/);
    const otherMove = teamMoves.create(db, other.input);
    expect(() => teamMoves.appendPath(db, otherMove.id, { path: "/tmp/merge-one", kind: "scratch" })).toThrow(/new path/);
    const planned = plan(db, record);
    expect(planned.afterTree).toBe(sha("7"));
    expect(teamMoves.plan(db, record.id, planned.publication!)).toEqual(planned);
    expect(() => plan(db, record, "a")).toThrow(/immutable/);
    expect(() => db.stmt("UPDATE team_moves SET paths='[]' WHERE id=?").run(record.id)).toThrow(/immutable/);
    expect(() => db.stmt("UPDATE team_moves SET publication=NULL,after_tree=NULL WHERE id=?").run(record.id)).toThrow(/immutable/);
    for (const entries of [
      [{ path: "../escape", before: null, after: { path: "../escape", mode: "100644" as const, oid: sha("2") } }],
      [{ path: "empty", before: null, after: null }],
      [{ path: "file", before: null, after: { path: "other", mode: "100644" as const, oid: sha("2") } }],
    ])
      expect(() => teamMoves.plan(db, otherMove.id, { afterTree: sha("a"), entries })).toThrow();
  });

  it("atomically applies only a matching pointer, HEAD, branch and fresh context", () => {
    const { db, input, thread } = fixture(),
      planned = plan(db, teamMoves.create(db, input));
    const wrong = teamContexts.create(db, { instanceId: input.instanceId, executionId: null, actorId: "lead", originExecutionId: null, reason: "compact", requestKey: "wrong", seed: input.seed });
    expect(() => teamMoves.apply(db, planned.id, { path: input.projectRoot, contextCheckpointId: wrong.id })).toThrow(/exact owned pointer/);
    for (const patch of [{ baseSha: sha("f") }, { branch: "wrong" }, { worktreePath: "/tmp/incorrect-current-pointer" }])
      expect(() =>
        db.transaction(() => {
          threads.update(db, thread.id, { workspaceMode: "current", worktreePath: null, baseSha: input.destinationBefore!.headSha, ...patch });
          const context = teamContexts.create(db, {
            instanceId: input.instanceId,
            executionId: null,
            actorId: "lead",
            originExecutionId: null,
            reason: "compact",
            requestKey: `move:${planned.id}`,
            seed: input.seed,
          });
          teamMoves.apply(db, planned.id, { path: input.projectRoot, contextCheckpointId: context.id });
        }),
      ).toThrow(/exact owned pointer/);
    expect(threads.get(db, thread.id)).toEqual(thread);
    const applied = apply(db, planned);
    expect(applied).toMatchObject({ state: "applied", appliedPath: input.projectRoot, afterTree: planned.publication!.afterTree });
    expect(teamMoves.pendingForThread(db, thread.id)).toEqual([]);
    expect(teamMoves.apply(db, applied.id, { path: applied.appliedPath!, contextCheckpointId: applied.appliedContextId! })).toEqual(applied);
    expect(() => teamMoves.requestCancel(db, applied.id)).toThrow(/applied/);
    expect(() => teamMoves.attention(db, applied.id, "Late failure")).toThrow(/finished/);
  });

  it("returns from its latest current origin, separating cleaned-source and new-workspace trees", () => {
    const { db, input } = fixture(),
      origin = apply(db, plan(db, teamMoves.create(db, input))),
      back = returnInput(origin);
    expect(() => teamMoves.create(db, { ...back, originMoveId: "unknown" })).toThrow(/latest applied current/);
    const foreign = fixture(db),
      foreignOrigin = apply(db, plan(db, teamMoves.create(db, foreign.input)));
    expect(() => teamMoves.create(db, { ...back, originMoveId: foreignOrigin.id })).toThrow(/latest applied current/);
    let returning = teamMoves.create(db, back);
    teamMoves.appendPath(db, returning.id, { path: "/tmp/return-old", kind: "workspace" });
    teamMoves.attention(db, returning.id, "Retain old files");
    teamMoves.appendPath(db, returning.id, { path: "/tmp/return-new", kind: "workspace" });
    teamMoves.appendPath(db, returning.id, { path: "/tmp/return-trial", kind: "scratch" });
    returning = plan(db, returning, "b");
    expect(returning.publication!.afterTree).toBe(sha("b"));
    expect(returning.afterTree).toBe(back.source.treeSha);
    expect(() => apply(db, returning, "/tmp/return-old")).toThrow(/newest workspace candidate/);
    const result = apply(db, returning, "/tmp/return-new");
    expect(result).toMatchObject({ state: "applied", appliedPath: "/tmp/return-new", afterTree: back.source.treeSha });
    expect(teamMoves.latestForThread(db, input.threadId)?.id).toBe(result.id);
    expect(teamMoves.forThread(db, input.threadId)).toHaveLength(2);
  });

  it("retains cancellation, blocks apply and releases only while the original pointer is intact", () => {
    const { db, input, thread } = fixture(),
      record = plan(db, teamMoves.create(db, input));
    expect(() => teamMoves.cancel(db, record.id)).toThrow(/explicit cancellation/);
    const requested = teamMoves.requestCancel(db, record.id);
    expect(teamMoves.requestCancel(db, record.id)).toEqual(requested);
    expect(() => apply(db, requested)).toThrow(/no cancellation/);
    expect(threads.get(db, thread.id)).toEqual(thread);
    expect(() => db.stmt("UPDATE team_moves SET cancel_requested=0 WHERE id=?").run(record.id)).toThrow(/immutable/);
    teamMoves.appendPath(db, record.id, { path: "/tmp/cancel-recovery", kind: "scratch" });
    expect(() =>
      db.transaction(() => {
        threads.update(db, thread.id, { worktreePath: "/tmp/changed" });
        teamMoves.cancel(db, record.id);
      }),
    ).toThrow(/original pointer/);
    const cancelled = teamMoves.cancel(db, record.id);
    expect(cancelled).toMatchObject({ state: "cancelled", cancelRequested: true, appliedPath: null, appliedContextId: null });
    expect(teamMoves.cancel(db, record.id)).toEqual(cancelled);
    expect(teamMoves.create(db, input)).toEqual(cancelled);
    expect(teamMoves.pendingForThread(db, thread.id)).toEqual([]);
    expect(() => teamMoves.appendPath(db, record.id, { path: "/tmp/late", kind: "scratch" })).toThrow(/finished/);
    expect(() => db.stmt("UPDATE team_moves SET state='pending' WHERE id=?").run(record.id)).toThrow(/immutable/);
    expect(teamMoves.create(db, { ...input, id: randomUUID(), requestKey: "new-intent" }).state).toBe("pending");
  });

  it("retains immutable negative requests mutually exclusive with admitted moves", () => {
    const { db, input } = fixture(),
      denied = { threadId: input.threadId, requestKey: input.requestKey, requestHash: input.requestHash, error: "Unsafe input" };
    const receipt = teamMoves.reject(db, denied);
    expect(teamMoves.reject(db, denied)).toEqual(receipt);
    expect(() => teamMoves.reject(db, { ...denied, requestHash: "b".repeat(64) })).toThrow(/different rejection/);
    expect(() => teamMoves.create(db, input)).toThrow(/rejected.*admitted/);
    expect(() => db.stmt("UPDATE team_move_rejections SET error='changed'").run()).toThrow(/immutable/);
    const accepted = teamMoves.create(db, { ...input, requestKey: "other" });
    expect(() => teamMoves.reject(db, { ...denied, requestKey: accepted.requestKey })).toThrow(/admitted.*rejected/);
    db.stmt("DELETE FROM projects WHERE id=?").run(input.projectId);
    expect(teamMoves.rejection(db, denied.threadId, denied.requestKey)).toEqual(receipt);
    expect(teamMoves.get(db, accepted.id)).toEqual(accepted);
  });

  it("allows a checkpoint restore from its owned current checkout and rejects unrelated sources", () => {
    const { db, input } = fixture();
    const current = apply(db, plan(db, teamMoves.create(db, input)));
    const checkpoint = checkpoints.insert(db, { threadId: input.threadId, runId: null, turn: 1, treeSha: sha("a"), diffStat: { files: 1, insertions: 1, deletions: 0, untracked: 0 } });
    const restore = {
      id: randomUUID(),
      threadId: input.threadId,
      instanceId: input.instanceId,
      projectId: input.projectId,
      projectRoot: input.projectRoot,
      requestKey: "restore-current",
      requestHash: "e".repeat(64),
      checkpointId: checkpoint.id,
      sourceRunId: null,
      before: snapshot(`/private${input.projectRoot}`, "4", "7"),
      targetTree: checkpoint.treeSha,
      setupInput: null,
      seed: "Restore from the owned current files",
      sourcePath: input.projectRoot,
    };
    expect(() => teamRestores.create(db, { ...restore, sourcePath: input.sourcePath })).toThrow(/current team workspace/);
    expect(() => teamRestores.create(db, { ...restore, sourcePath: "/tmp/unrelated" })).toThrow(/current team workspace/);
    const record = teamRestores.create(db, restore);
    expect(record.sourcePath).toBe(current.appliedPath);
    teamRestores.appendPath(db, record.id, "/tmp/restored-current-copy");
    const applied = db.transaction(() => {
      threads.update(db, input.threadId, {
        workspaceMode: "worktree",
        worktreePath: "/tmp/restored-current-copy",
        baseSha: record.before.headSha,
        branch: `openorc/team-${input.threadId}-restore-${record.id}`,
      });
      const context = teamContexts.create(db, {
        instanceId: input.instanceId,
        executionId: null,
        actorId: "lead",
        originExecutionId: null,
        reason: "compact",
        requestKey: `restore:${record.id}`,
        seed: record.seed,
      });
      return teamRestores.apply(db, record.id, { path: "/tmp/restored-current-copy", contextCheckpointId: context.id });
    });
    expect(applied.state).toBe("applied");
  });

  it("migrates fixed version 20, reopens recovery and retains manifests through owner deletion", () => {
    const folder = mkdtempSync(join(tmpdir(), "openorc-move-journal-"));
    folders.push(folder);
    const file = join(folder, "fixture.sqlite"),
      raw = new DatabaseSync(file);
    for (const migration of migrations.slice(0, 20)) typeof migration === "string" ? raw.exec(migration) : migration(raw);
    raw.exec("PRAGMA user_version=20");
    const old = new Db(raw),
      f = fixture(old);
    const before = teamContexts.create(old, {
      instanceId: f.instance.id,
      executionId: null,
      actorId: "lead",
      originExecutionId: null,
      reason: "compact",
      requestKey: "pre-upgrade",
      seed: "Retain checkpoint",
    });
    old.close();
    opened.delete(old);
    const db = Db.open(file);
    opened.add(db);
    expect(db.version).toBeGreaterThanOrEqual(21);
    expect(teamContexts.get(db, before.id)).toEqual(before);
    const applied = apply(db, plan(db, teamMoves.create(db, f.input))),
      pending = teamMoves.create(db, returnInput(applied));
    teamMoves.appendPath(db, pending.id, { path: "/tmp/reopen-candidate", kind: "workspace" });
    const retained = teamMoves.attention(db, pending.id, "Partial cleanup needs recovery");
    const rejected = teamMoves.reject(db, { threadId: f.thread.id, requestKey: "denied", requestHash: "f".repeat(64), error: "Retain rejection" });
    db.close();
    opened.delete(db);
    const reopened = Db.open(file);
    opened.add(reopened);
    expect(teamMoves.get(reopened, applied.id)).toEqual(applied);
    expect(teamMoves.get(reopened, pending.id)).toEqual(retained);
    reopened.stmt("DELETE FROM projects WHERE id=?").run(f.project.id);
    expect(teamMoves.apply(reopened, applied.id, { path: applied.appliedPath!, contextCheckpointId: applied.appliedContextId! })).toEqual(applied);
    expect(teamMoves.get(reopened, retained.id)).toEqual(retained);
    expect(teamMoves.rejection(reopened, f.thread.id, "denied")).toEqual(rejected);
    expect(reopened.stmt("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
