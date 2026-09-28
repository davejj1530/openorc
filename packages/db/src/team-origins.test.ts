import { insertLegacyRun } from "./fixtures/legacy-run.js";
import { teamJournalWriter } from "./fixtures/legacy-team-journal.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TEAM_LIMITS, MAX_TEAM_CONTEXT_BYTES } from "@openorc/protocol";
import { Db } from "./database.js";
import { migrations } from "./schema.js";
import { orchestration } from "./orchestration.js";
import { projects, runs, threads } from "./repos.js";
import { teamRuntime } from "./team-runtime.js";
import { teamOrigins } from "./team-origins.js";
import { teamOriginMigration } from "./team-origin-schema.js";

const opened = new Set<Db>(),
  folders: string[] = [];
afterEach(() => {
  for (const db of opened) db.close();
  opened.clear();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const settings = { agent: "codex" as const, model: "fixture", effort: null, fastMode: false };
function fixture(db = Db.memory()) {
  opened.add(db);
  const project = projects.insert(db, { name: "Fork", rootPath: `/tmp/${randomUUID()}`, defaultBranch: "main", gitRemote: null, settings: {} });
  const saved = orchestration.save(db, {
    projectId: project.id,
    expectedRevisionId: null,
    draft: { name: "Fork team", limits: DEFAULT_TEAM_LIMITS, members: [{ key: "lead", name: "Lead", managerKey: null, responsibility: "Work", settings }] },
  });
  const add = () => {
    const thread = threads.insert(db, { projectId: project.id, title: "Fork", ...settings, mode: "act", permissionMode: "trusted" });
    return { thread, instance: orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: saved.revision.id }) };
  };
  const source = add(),
    target = add();
  const run = insertLegacyRun(db, { id: randomUUID(), threadId: source.thread.id, taskId: null, ...settings, mode: "act", permissionMode: "trusted" });
  runs.update(db, run.id, { state: "success", externalSessionId: "source-session", resultText: "Source result", endedAt: 100 });
  const initial = teamJournalWriter(db).create(db, {
    id: randomUUID(),
    instanceId: source.instance.id,
    threadId: source.thread.id,
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
        input: { title: "Work", spec: "Retain this instruction", attachments: [], responsibility: "Work", settings },
        state: "completed",
        retries: 0,
        directionVersion: 0,
        deliveredVersion: 0,
        disposition: null,
        result: "Result",
        snapshotId: null,
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
  const execution = teamJournalWriter(db).update(db, initial.id, (state) => {
    state.state = "completed";
    state.attempts.push({
      id: randomUUID(),
      actorId: "lead",
      runId: run.id,
      generation: 1,
      state: "closed",
      settings,
      configurationVersion: 1,
      directionVersion: 0,
      messageIds: [],
      snapshotId: null,
      error: null,
      createdAt: 10,
      endedAt: 100,
    });
  }).record;
  const input = { instanceId: target.instance.id, sourceThreadId: source.thread.id, sourceInstanceId: source.instance.id, sourceRunId: run.id, seed: "Immutable inherited instruction" };
  return { db, project, source, target, execution, run, input, add };
}

describe("independent team fork origins", () => {
  it("replays exact context, rejects replacement, and participates in caller rollback", () => {
    const { db, input } = fixture();
    expect(() =>
      db.transaction(() => {
        teamOrigins.create(db, input);
        throw Error("rollback");
      }),
    ).toThrow("rollback");
    expect(teamOrigins.get(db, input.instanceId)).toBeNull();
    const first = teamOrigins.create(db, input);
    expect(teamOrigins.create(db, input)).toEqual(first);
    for (const change of [{ seed: "Changed" }, { sourceRunId: null }, { sourceThreadId: "changed" }, { sourceInstanceId: "changed" }]) {
      expect(() => teamOrigins.create(db, { ...input, ...change })).toThrow(/different fork context/);
    }
    expect(() => db.stmt("UPDATE team_origins SET seed='replacement' WHERE instance_id=?").run(input.instanceId)).toThrow(/immutable/);
    expect(() => db.stmt("DELETE FROM team_origins WHERE instance_id=?").run(input.instanceId)).toThrow(/retained/);
  });

  it("requires a distinct same-project source instance and its exact lead run at insertion", () => {
    const { db, source, input } = fixture();
    const foreign = fixture(db);
    const unbound = runs.insert(db, { id: randomUUID(), taskId: null, threadId: source.thread.id, ...settings, mode: "act", permissionMode: "trusted" });
    for (const change of [
      { instanceId: "missing" },
      { sourceInstanceId: "missing" },
      { instanceId: source.instance.id },
      { sourceThreadId: foreign.source.thread.id },
      { sourceRunId: foreign.run.id },
      { sourceRunId: unbound.id },
      { sourceThreadId: foreign.source.thread.id, sourceInstanceId: foreign.source.instance.id, sourceRunId: foreign.run.id },
    ])
      expect(() => teamOrigins.create(db, { ...input, ...change })).toThrow();
    expect(teamOrigins.get(db, input.instanceId)).toBeNull();
    expect(teamOrigins.create(db, { ...input, sourceRunId: null }).sourceRunId).toBeNull();
  });

  it("enforces UTF-8 bounds through the repository and raw SQL", () => {
    const { db, input, add } = fixture();
    const seed = "🧠".repeat(MAX_TEAM_CONTEXT_BYTES / 4);
    expect(() => teamOrigins.create(db, { ...input, seed: `${seed}é` })).toThrow(/UTF-8/);
    expect(teamOrigins.create(db, { ...input, seed }).seed).toBe(seed);
    const next = add();
    expect(() => db.stmt("INSERT INTO team_origins VALUES(?,?,?,?,?,?)").run(next.instance.id, input.sourceThreadId, input.sourceInstanceId, input.sourceRunId, `${seed}x`, 1)).toThrow(/CHECK/);
    expect(() => db.stmt("INSERT INTO team_origins VALUES(?,?,?,?,?,?)").run(next.instance.id, "foreign", input.sourceInstanceId, input.sourceRunId, "text", 1)).toThrow(/source lead/);
  });

  it("upgrades existing journals and survives source deletion/reopen while cascading only with the destination", () => {
    const folder = mkdtempSync(join(tmpdir(), "openorc-fork-origin-"));
    folders.push(folder);
    const file = join(folder, "fixture.sqlite"),
      raw = new DatabaseSync(file);
    const prior = migrations.indexOf(teamOriginMigration);
    expect(prior).toBeGreaterThan(0);
    for (const migration of migrations.slice(0, prior)) typeof migration === "string" ? raw.exec(migration) : migration(raw);
    raw.exec(`PRAGMA user_version=${prior}`);
    const old = new Db(raw),
      f = fixture(old);
    old.close();
    opened.delete(old);
    const db = Db.open(file);
    opened.add(db);
    expect(teamRuntime.get(db, f.execution.id)).toEqual(f.execution);
    const origin = teamOrigins.create(db, f.input);
    threads.delete(db, f.source.thread.id);
    expect(teamOrigins.get(db, f.target.instance.id)).toEqual(origin);
    expect(teamOrigins.create(db, f.input)).toEqual(origin);
    db.close();
    opened.delete(db);
    const reopened = Db.open(file);
    opened.add(reopened);
    expect(teamOrigins.get(reopened, f.target.instance.id)).toEqual(origin);
    expect(reopened.stmt("SELECT count(*) AS n FROM team_run_bindings b JOIN team_executions e ON e.id=b.execution_id WHERE e.instance_id=?").get(f.target.instance.id)).toEqual({ n: 0 });
    threads.delete(reopened, f.target.thread.id);
    expect(teamOrigins.get(reopened, f.target.instance.id)).toBeNull();
    expect(reopened.stmt("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
