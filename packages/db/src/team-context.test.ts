import { insertLegacyRun } from "./fixtures/legacy-run.js";
import { LEGACY_TEAM_PROMPT, legacyTeamRuntime, readLegacyJournals, teamJournalWriter } from "./fixtures/legacy-team-journal.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_TEAM_CONTEXT_BYTES,
  type TeamActorRecord,
  type TeamAttemptRecord,
  type TeamContextCheckpoint,
  type TeamDraft,
  type TeamExecutionRecord,
  type TeamPublicationRecord,
  type TeamWorkspaceRecord,
} from "@openorc/protocol";
import { Db } from "./database.js";
import { orchestration } from "./orchestration.js";
import { projects, runs, tasks, threads } from "./repos.js";
import { migrations } from "./schema.js";
import { teamContexts, type CreateTeamContextInput } from "./team-context.js";
import { teamRuntime } from "./team-runtime.js";
import { teamWorkspaces } from "./team-workspaces.js";

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
function actor(id: string, taskId: string | null): TeamActorRecord {
  return {
    id,
    memberKey: taskId ? "worker" : "coordinator",
    taskId,
    parentId: taskId ? "lead" : null,
    requestKey: taskId ? id : null,
    requestHash: taskId ? `hash-${id}` : null,
    dependencies: [],
    input: { title: "Retained work", spec: "Keep the user direction", attachments: [], responsibility: "Implement", settings },
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
function fixture(db = Db.memory()) {
  opened.add(db);
  const project = projects.insert(db, { name: "Context fixture", rootPath: `/tmp/context-${randomUUID()}`, defaultBranch: "main", gitRemote: null, settings: {} });
  const thread = threads.insert(db, { projectId: project.id, title: "Team context", ...settings, mode: "act", permissionMode: "trusted" });
  const draft: TeamDraft = {
    name: "Context team",
    limits: { maxConcurrentAgents: 2, maxAssignments: 12, maxExecutionMinutes: 60, maxAttemptsPerAssignment: 3 },
    members: [
      { key: "coordinator", name: "Lead", managerKey: null, responsibility: "Coordinate", settings },
      { key: "worker", name: "Worker", managerKey: "coordinator", responsibility: "Implement", settings },
    ],
  };
  const team = orchestration.save(db, { projectId: project.id, expectedRevisionId: null, draft });
  const instance = orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: team.revision.id });
  const initial: TeamExecutionRecord = {
    id: randomUUID(),
    instanceId: instance.id,
    projectId: project.id,
    threadId: thread.id,
    state: "active",
    generation: 1,
    revision: 0,
    limits: draft.limits,
    actors: [actor("lead", null)],
    attempts: [],
    messages: [],
    error: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    deadlineAt: 3_601_000,
  };
  teamJournalWriter(db).create(db, initial);
  const record = teamJournalWriter(db).update(db, initial.id, (item) => {
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
      origin: "agent",
    });
    item.actors.push(actor("worker-1", task.id));
  }).record;
  const lead = { instanceId: instance.id, executionId: null, actorId: "lead" };
  const worker = { instanceId: instance.id, executionId: record.id, actorId: "worker-1" };
  const input: CreateTeamContextInput = { ...lead, originExecutionId: record.id, reason: "fresh_retry", requestKey: "fresh-once", seed: "Canonical direction and accepted results" };
  return { db, project, thread, team, instance, initial, record, lead, worker, input };
}
function attempt(record: TeamExecutionRecord, actorId: string, contextCheckpointId?: string): TeamAttemptRecord {
  return {
    id: randomUUID(),
    actorId,
    runId: null,
    generation: record.generation,
    state: "starting",
    settings,
    configurationVersion: 1,
    directionVersion: 0,
    messageIds: [],
    attachments: ["/managed/input.png"],
    snapshotId: null,
    error: null,
    createdAt: 2_000,
    endedAt: null,
    ...(contextCheckpointId ? { contextCheckpointId, contextSeed: "Reserved canonical context" } : {}),
  };
}
function rawInsert(db: Db, value: TeamContextCheckpoint) {
  return db
    .stmt("INSERT INTO team_context_checkpoints (id, instance_id, execution_id, actor_id, origin_execution_id, epoch, reason, request_key, seed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(value.id, value.instanceId, value.executionId, value.actorId, value.originExecutionId, value.epoch, value.reason, value.requestKey, value.seed, value.createdAt);
}

describe("durable team context", () => {
  it("maintains independent lead and assignment epochs and scoped request replay", () => {
    const { db, instance, lead, worker, input } = fixture();
    const first = teamContexts.create(db, input);
    const child = teamContexts.create(db, { ...input, ...worker });
    const second = teamContexts.create(db, { ...input, requestKey: "compact-once", reason: "compact", originExecutionId: null, seed: "Condensed canonical context" });
    expect([first.epoch, child.epoch, second.epoch]).toEqual([1, 1, 2]);
    expect(teamContexts.create(db, input)).toEqual(first);
    expect(teamContexts.latest(db, lead)).toEqual(second);
    expect(teamContexts.latest(db, worker)).toEqual(child);
    expect(teamContexts.findRequest(db, { ...lead, requestKey: input.requestKey })).toEqual(first);
    expect(teamContexts.findRequest(db, { ...worker, requestKey: "compact-once" })).toBeNull();
    expect(teamContexts.get(db, "missing")).toBeNull();
    expect(teamContexts.listForInstance(db, instance.id)).toEqual([first, child, second]);
  });

  it("rejects changed replay payloads including a later lead recovery's originating execution", () => {
    const { db, instance, initial, record, input } = fixture();
    const first = teamContexts.create(db, input);
    teamRuntime.update(db, record.id, (item) => {
      item.state = "stopped";
    });
    const next = teamRuntime.create(db, { ...initial, id: randomUUID() });
    for (const changes of [{ seed: "Changed direction" }, { reason: "compact" as const, originExecutionId: null }, { originExecutionId: next.id }]) {
      expect(() => teamContexts.create(db, { ...input, ...changes })).toThrow(/different recovery/);
    }
    expect(teamContexts.listForInstance(db, instance.id)).toEqual([first]);
    expect(teamContexts.create(db, input)).toEqual(first);
  });

  it("rejects cross-instance, absent actor and invalid lead/member ownership before saving", () => {
    const { db, instance, worker, input } = fixture();
    const other = fixture(db);
    for (const changes of [
      { instanceId: "missing" },
      { instanceId: other.instance.id },
      { originExecutionId: other.record.id },
      { executionId: input.originExecutionId },
      { actorId: worker.actorId },
      { originExecutionId: null },
      { ...worker, actorId: "absent" },
      { ...worker, originExecutionId: other.record.id },
    ])
      expect(() => teamContexts.create(db, { ...input, ...changes })).toThrow();
    expect(teamContexts.listForInstance(db, instance.id)).toEqual([]);
    expect(teamContexts.listForInstance(db, other.instance.id)).toEqual([]);
    expect(teamContexts.create(db, { ...input, reason: "compact", originExecutionId: null }).epoch).toBe(1);
    expect(() => teamContexts.create(db, { ...input, reason: "compact", requestKey: "invalid-origin" })).toThrow(/Compaction/);
    expect(() => teamContexts.create(db, { ...input, ...worker, reason: "compact" })).toThrow(/Compaction/);
  });

  it("bounds seeds by UTF-8 bytes without truncating accepted text", () => {
    const { db, input } = fixture();
    const seed = "é".repeat(MAX_TEAM_CONTEXT_BYTES / 2);
    expect(teamContexts.create(db, { ...input, seed }).seed).toBe(seed);
    expect(() => teamContexts.create(db, { ...input, requestKey: "too-large", seed: `${seed}a` })).toThrow(/UTF-8/);
    expect(() => teamContexts.create(db, { ...input, requestKey: "emoji-overflow", seed: "🧠".repeat(MAX_TEAM_CONTEXT_BYTES / 4 + 1) })).toThrow(/UTF-8/);
    expect(teamContexts.create(db, { ...input, requestKey: "emoji-boundary", seed: "🧠".repeat(MAX_TEAM_CONTEXT_BYTES / 4) }).epoch).toBe(2);
  });

  it("enforces immutable rows and nullable-scope uniqueness even through raw SQL", () => {
    const { db, input, worker } = fixture();
    const first = teamContexts.create(db, input);
    expect(() => db.stmt("UPDATE team_context_checkpoints SET seed = ? WHERE id = ?").run("replaced", first.id)).toThrow(/immutable/);
    expect(() => db.stmt("DELETE FROM team_context_checkpoints WHERE id = ?").run(first.id)).toThrow(/retained/);
    expect(() => rawInsert(db, { ...first, id: randomUUID(), requestKey: "new-key" })).toThrow(/UNIQUE/);
    expect(() => rawInsert(db, { ...first, id: randomUUID(), epoch: 2 })).toThrow(/UNIQUE/);
    expect(() => rawInsert(db, { ...first, id: randomUUID(), epoch: 2, requestKey: "large", seed: "x".repeat(MAX_TEAM_CONTEXT_BYTES + 1) })).toThrow(/CHECK/);
    expect(() => rawInsert(db, { ...first, ...worker, actorId: "missing-actor", id: randomUUID() })).toThrow(/originating execution/);
    expect(() => rawInsert(db, { ...first, ...worker, reason: "compact", id: randomUUID() })).toThrow(/CHECK/);
    expect(teamContexts.get(db, first.id)).toEqual(first);
  });

  it("pins each attempt to immutable exact actor context and rolls back invalid journal changes", () => {
    const { db, record, worker, input } = fixture();
    const leadCheckpoint = teamContexts.create(db, input);
    const childCheckpoint = teamContexts.create(db, { ...input, ...worker });
    const other = fixture(db);
    const foreign = teamContexts.create(db, other.input);
    const saved = teamRuntime.update(db, record.id, (item) => {
      item.attempts.push(attempt(item, "lead", leadCheckpoint.id), attempt(item, worker.actorId, childCheckpoint.id));
    }).record;
    for (const [actorId, contextId] of [
      ["lead", childCheckpoint.id],
      [worker.actorId, leadCheckpoint.id],
      ["lead", foreign.id],
      ["lead", "missing"],
    ]) {
      expect(() =>
        teamRuntime.update(db, record.id, (item) => {
          item.actors[0]!.error = "must rollback";
          item.attempts.push(attempt(item, actorId!, contextId));
        }),
      ).toThrow(/context|checkpoint/i);
    }
    const later = teamContexts.create(db, { ...input, requestKey: "later" });
    expect(() =>
      teamRuntime.update(db, record.id, (item) => {
        item.attempts[0]!.contextCheckpointId = later.id;
      }),
    ).toThrow(/immutable/);
    expect(() =>
      teamRuntime.update(db, record.id, (item) => {
        delete item.attempts[0]!.contextCheckpointId;
        delete item.attempts[0]!.contextSeed;
      }),
    ).toThrow(/immutable/);
    expect(() =>
      teamRuntime.update(db, record.id, (item) => {
        item.attempts[0]!.contextSeed = "Changed reserved seed";
      }),
    ).toThrow(/immutable/);
    expect(teamRuntime.get(db, record.id)).toEqual(saved);
    const legacy = teamRuntime.update(db, record.id, (item) => {
      item.attempts.push(attempt(item, "lead"));
    }).record;
    expect(() =>
      teamRuntime.update(db, record.id, (item) => {
        item.attempts.at(-1)!.contextCheckpointId = later.id;
        item.attempts.at(-1)!.contextSeed = "Late context";
      }),
    ).toThrow(/immutable/);
    expect(teamRuntime.get(db, record.id)).toEqual(legacy);
  });

  it("shares lead context across goals but never reuses an assignment's context in a new execution", () => {
    const { db, initial, record, worker, input } = fixture();
    const lead = teamContexts.create(db, input);
    const child = teamContexts.create(db, { ...input, ...worker });
    teamRuntime.update(db, record.id, (item) => {
      item.state = "stopped";
    });
    const next = teamRuntime.create(db, { ...initial, id: randomUUID() });
    teamRuntime.update(db, next.id, (item) => {
      const task = tasks.insert(db, {
        projectId: item.projectId,
        threadId: item.threadId,
        title: "New assignment",
        spec: "Different work",
        priority: "none",
        labels: [],
        workspaceMode: "worktree",
        baseRef: "main",
        parentTaskId: null,
        origin: "agent",
      });
      item.actors.push(actor(worker.actorId, task.id));
      item.attempts.push(attempt(item, "lead", lead.id));
    });
    expect(() =>
      teamRuntime.update(db, next.id, (item) => {
        item.attempts.push(attempt(item, worker.actorId, child.id));
      }),
    ).toThrow(/context|checkpoint/i);
    expect(teamRuntime.get(db, next.id)?.attempts).toHaveLength(1);
  });

  it("rolls back checkpoint creation with the surrounding transaction and preserves epoch ordering", () => {
    const { db, instance, record, input } = fixture();
    expect(() =>
      db.transaction(() => {
        teamContexts.create(db, input);
        throw new Error("Admission failed");
      }),
    ).toThrow(/Admission failed/);
    expect(teamContexts.listForInstance(db, instance.id)).toEqual([]);
    expect(() =>
      teamRuntime.update(db, record.id, (item) => {
        teamContexts.create(db, input);
        item.actors = [];
      }),
    ).toThrow();
    expect(teamContexts.listForInstance(db, instance.id)).toEqual([]);
    expect(teamContexts.create(db, input).epoch).toBe(1);
    expect(teamRuntime.get(db, record.id)).toEqual(record);
  });

  it("resumes only an established provider session belonging to the same actor and checkpoint", () => {
    const { db, initial, record, input, worker } = fixture();
    const checkpoint = teamContexts.create(db, input);
    const childCheckpoint = teamContexts.create(db, { ...input, ...worker });
    const otherCheckpoint = teamContexts.create(db, { ...input, requestKey: "different-checkpoint" });
    const source = teamRuntime.update(db, record.id, (item) => {
      for (const [actorId, contextId, sessionId] of [
        ["lead", checkpoint.id, "lead-session"],
        [worker.actorId, childCheckpoint.id, "worker-session"],
        ["lead", otherCheckpoint.id, "old-boundary-session"],
      ]) {
        const turn = attempt(item, actorId!, contextId);
        const owner = item.actors.find((actor) => actor.id === actorId)!;
        const run = runs.insert(db, { id: randomUUID(), taskId: owner.taskId, threadId: owner.taskId ? null : item.threadId, ...settings, mode: "act", permissionMode: "trusted" });
        runs.update(db, run.id, { externalSessionId: sessionId, state: "success" });
        item.attempts.push({ ...turn, runId: run.id, state: "closed", endedAt: 3_000 });
      }
    }).record;
    const resume = { ...attempt(source, "lead", checkpoint.id), contextSessionId: "lead-session" };
    delete resume.contextSeed;
    const resumed = teamRuntime.update(db, record.id, (item) => {
      item.attempts.push(resume);
    }).record;
    for (const changes of [
      { contextSessionId: "missing" },
      { contextSessionId: "worker-session" },
      { contextSessionId: "old-boundary-session" },
      { settings: { ...settings, agent: "claude" as const } },
    ]) {
      expect(() =>
        teamRuntime.update(db, record.id, (item) => {
          item.attempts.push({ ...resume, id: randomUUID(), ...changes });
        }),
      ).toThrow(/context session/);
    }
    expect(() =>
      teamRuntime.update(db, record.id, (item) => {
        item.attempts.at(-1)!.contextSessionId = "old-boundary-session";
      }),
    ).toThrow(/immutable/);
    expect(teamRuntime.get(db, record.id)).toEqual(resumed);
    teamRuntime.update(db, record.id, (item) => {
      item.state = "stopped";
    });
    const next = teamRuntime.create(db, { ...initial, id: randomUUID() });
    expect(
      teamRuntime.update(db, next.id, (item) => {
        item.attempts.push({ ...resume, id: randomUUID() });
      }).record.attempts[0]?.contextSessionId,
    ).toBe("lead-session");
    const foreign = fixture(db);
    const foreignCheckpoint = teamContexts.create(db, foreign.input);
    expect(() =>
      teamRuntime.update(db, foreign.record.id, (item) => {
        item.attempts.push({ ...resume, id: randomUUID(), contextCheckpointId: foreignCheckpoint.id });
      }),
    ).toThrow(/context session/);
  });

  it("requires a bounded seed or session reservation exactly when a checkpoint is selected", () => {
    const { db, record, input } = fixture();
    const checkpoint = teamContexts.create(db, input);
    const fresh = attempt(record, "lead", checkpoint.id);
    for (const changes of [{ contextSeed: undefined }, { contextSessionId: "session-too" }, { contextCheckpointId: undefined }, { contextSeed: "🧠".repeat(MAX_TEAM_CONTEXT_BYTES / 4 + 1) }])
      expect(() =>
        teamRuntime.update(db, record.id, (item) => {
          item.attempts.push({ ...fresh, ...changes });
        }),
      ).toThrow();
    expect(teamRuntime.get(db, record.id)).toEqual(record);
  });

  it("migrates fixed version 10 and reopens context without losing old attempts, images, workspaces or publication recovery", () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), "team-context-migration-"));
    folders.push(folder);
    const file = path.join(folder, "ledger.sqlite");
    const raw = new DatabaseSync(file);
    for (const migration of migrations.slice(0, 10)) typeof migration === "string" ? raw.exec(migration) : migration(raw);
    raw.exec("PRAGMA user_version = 10");
    const restore = readLegacyJournals();
    const { db, project, thread, team, instance, record, worker, input } = fixture(new Db(raw));
    const run = insertLegacyRun(db, { id: randomUUID(), taskId: null, threadId: thread.id, ...settings, mode: "act", permissionMode: "trusted" });
    const saved = legacyTeamRuntime.update(db, record.id, (item) => {
      item.actors[0]!.directionVersion = 1;
      item.actors[1]!.state = "completed";
      item.actors[1]!.result = "Retained worker output";
      const turn = { ...attempt(item, "lead"), runId: run.id, state: "closed" as const, endedAt: 3_000 };
      item.attempts.push(turn);
      item.messages.push({
        id: "old-image-direction",
        sequence: 1,
        senderId: "user",
        recipientId: "lead",
        kind: "direction",
        body: "Keep the design",
        attachments: ["/managed/design.png"],
        dedupeKey: "old-image-key",
        state: "pending",
        attemptId: null,
        createdAt: 3_001,
        deliveredAt: null,
      });
    }).record;
    const oid = (text: string) => text.repeat(40);
    const leadPath = path.join(folder, "lead");
    const source = {
      rootPath: project.rootPath,
      headSha: oid("a"),
      branch: "refs/heads/main",
      treeSha: oid("b"),
      treeRef: "refs/openorc/team/input/tree",
      headRef: "refs/openorc/team/input/head",
      indexSha256: "c".repeat(64),
    };
    const workspaces: TeamWorkspaceRecord[] = saved.actors.map((item) => ({
      id: randomUUID(),
      executionId: record.id,
      actorId: item.id,
      taskId: item.taskId,
      parentActorId: item.parentId,
      path: item.id === "lead" ? leadPath : path.join(folder, "worker"),
      source: { ...source, rootPath: item.id === "lead" ? project.rootPath : leadPath },
      state: "ready",
      setupState: "completed",
      preparedTree: oid("b"),
      outputTree: item.id === "lead" ? null : oid("d"),
      error: null,
      createdAt: 4_000,
      updatedAt: 4_000,
    }));
    for (const workspace of workspaces) teamWorkspaces.save(db, workspace);
    const publication: TeamPublicationRecord = {
      id: randomUUID(),
      executionId: record.id,
      sourceActorId: worker.actorId,
      targetActorId: "lead",
      outputTree: oid("d"),
      destinationPath: leadPath,
      before: { ...source, rootPath: leadPath },
      afterTree: oid("e"),
      scratchPath: path.join(folder, "scratch"),
      state: "attention",
      entries: [],
      includedActorIds: [worker.actorId],
      error: "Interrupted publication",
      createdAt: 5_000,
      updatedAt: 5_000,
    };
    teamWorkspaces.savePublication(db, publication);
    restore();
    close(db);
    const migrated = Db.open(file);
    opened.add(migrated);
    expect(migrated.version).toBe(migrations.length);
    expect(teamRuntime.get(migrated, record.id)).toEqual(saved);
    expect(teamRuntime.prompt(migrated, record.id, saved.attempts[0]!.id)).toBe(LEGACY_TEAM_PROMPT);
    expect(teamContexts.listForInstance(migrated, instance.id)).toEqual([]);
    const checkpoint = teamContexts.create(migrated, input);
    const recovered = teamRuntime.update(migrated, record.id, (item) => {
      item.attempts.push(attempt(item, "lead", checkpoint.id));
    }).record;
    close(migrated);
    const reopened = Db.open(file);
    opened.add(reopened);
    expect(teamContexts.get(reopened, checkpoint.id)).toEqual(checkpoint);
    expect(teamContexts.create(reopened, input)).toEqual(checkpoint);
    expect(teamRuntime.get(reopened, record.id)).toEqual(recovered);
    expect(orchestration.get(reopened, team.team.id)).toEqual(team);
    expect(orchestration.getInstance(reopened, thread.id)).toEqual(instance);
    expect(runs.get(reopened, run.id)).toEqual({ ...run, workingDirectory: null, commentTurnId: null });
    expect(teamRuntime.binding(reopened, run.id)?.executionId).toBe(record.id);
    expect(teamWorkspaces.list(reopened).sort((a, b) => a.actorId.localeCompare(b.actorId))).toEqual(workspaces.sort((a, b) => a.actorId.localeCompare(b.actorId)));
    expect(teamWorkspaces.publications(reopened)).toEqual([publication]);
    expect(reopened.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
