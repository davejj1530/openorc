import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TEAM_LIMITS } from "@openorc/protocol";
import { Db } from "./database.js";
import { migrations } from "./schema.js";
import { orchestration } from "./orchestration.js";
import { projects, threads } from "./repos.js";
import { teamOrigins } from "./team-origins.js";
import { teamContexts } from "./team-context.js";
import { teamForks, type CreateTeamForkInput, type TeamForkRecord } from "./team-forks.js";
import { teamForkMigration } from "./team-fork-schema.js";

const opened = new Set<Db>(),
  folders: string[] = [];
afterEach(() => {
  for (const db of opened) db.close();
  opened.clear();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const settings = { agent: "codex" as const, model: "fixture", effort: "high", fastMode: true };
function fixture(db = Db.memory()) {
  opened.add(db);
  const project = projects.insert(db, { name: "Fork journal", rootPath: `/tmp/${randomUUID()}`, defaultBranch: "main", gitRemote: null, settings: {} });
  const team = orchestration.save(db, {
    projectId: project.id,
    expectedRevisionId: null,
    draft: { name: "Team", limits: DEFAULT_TEAM_LIMITS, members: [{ key: "lead", name: "Lead", managerKey: null, responsibility: "Work", settings }] },
  });
  const source = threads.insert(db, { projectId: project.id, title: "Source", ...settings, mode: "act", permissionMode: "review" });
  const instance = orchestration.createInstance(db, { threadId: source.id, teamRevisionId: team.revision.id });
  const input: CreateTeamForkInput = {
    id: randomUUID(),
    sourceThreadId: source.id,
    sourceInstanceId: instance.id,
    projectId: project.id,
    projectRoot: project.rootPath,
    destinationThreadId: randomUUID(),
    requestKey: "fork-once",
    requestHash: "a".repeat(64),
    setupInput: null,
    seed: "Exact original requirements",
    sourceRunId: null,
    upToRunId: null,
    teamRevisionId: team.revision.id,
    leadOverrides: {},
    thread: { title: "Independent fork", ...settings, mode: "act", permissionMode: "review" },
    snapshot: {
      rootPath: project.rootPath,
      headSha: "1".repeat(40),
      branch: "refs/heads/main",
      treeSha: "2".repeat(40),
      treeRef: "refs/openorc/forks/fixture/tree",
      headRef: "refs/openorc/forks/fixture/head",
      indexSha256: "3".repeat(64),
    },
  };
  return { db, project, team, source, instance, input };
}
function destination(db: Db, record: TeamForkRecord, workspace: string, seed = record.seed) {
  const thread = threads.insert(db, { id: record.destinationThreadId, projectId: record.projectId, ...record.thread, workspaceMode: "worktree" });
  threads.update(db, thread.id, { worktreePath: workspace, baseSha: record.snapshot.headSha });
  const instance = orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: record.teamRevisionId, initialLeadOverrides: record.leadOverrides });
  teamOrigins.create(db, { instanceId: instance.id, sourceThreadId: record.sourceThreadId, sourceInstanceId: record.sourceInstanceId, sourceRunId: record.sourceRunId, seed });
  teamContexts.create(db, { instanceId: instance.id, executionId: null, actorId: "lead", originExecutionId: null, reason: "compact", requestKey: "fork-context", seed });
  return instance;
}

describe("durable independent team fork manifests", () => {
  it("refuses a structurally valid SQL recovery row with a malformed captured snapshot", () => {
    const { db, input } = fixture();
    const good = teamForks.create(db, input);
    const row = db.stmt("SELECT captured_input FROM team_forks WHERE id=?").get(good.id) as { captured_input: string };
    const capture = { ...JSON.parse(row.captured_input), snapshot: null };
    const malformedId = randomUUID();
    db.stmt(
      "INSERT INTO team_forks(id,source_thread_id,source_instance_id,project_id,request_key,request_hash,destination_thread_id,captured_input,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'pending',1,1)",
    ).run(malformedId, input.sourceThreadId, input.sourceInstanceId, input.projectId, "malformed-snapshot", input.requestHash, randomUUID(), JSON.stringify(capture));
    expect(() => teamForks.get(db, malformedId)).toThrow(`Fork recovery intent ${malformedId} could not be read. Preserve the database for recovery.`);
    expect(teamForks.get(db, good.id)).toEqual(good);
  });

  it("retains immutable negative requests and rejects changed replay or later admission", () => {
    const { db, input } = fixture();
    const denied = { sourceThreadId: input.sourceThreadId, requestKey: input.requestKey, requestHash: input.requestHash, error: "The selected checkpoint has no exact capture." };
    const receipt = teamForks.reject(db, denied);
    expect(teamForks.reject(db, denied)).toEqual(receipt);
    expect(teamForks.rejection(db, input.sourceThreadId, input.requestKey)).toEqual(receipt);
    expect(teamForks.find(db, input.sourceThreadId, input.requestKey)).toBeNull();
    expect(() => teamForks.reject(db, { ...denied, requestHash: "b".repeat(64) })).toThrow(/different rejection/);
    expect(() => teamForks.reject(db, { ...denied, error: "A changed reason" })).toThrow(/different rejection/);
    expect(() => teamForks.create(db, input)).toThrow(/rejected.*admitted/);
    expect(() => db.stmt("UPDATE team_fork_rejections SET error='Changed' WHERE source_thread_id=?").run(input.sourceThreadId)).toThrow(/immutable/);
    expect(() => db.stmt("DELETE FROM team_fork_rejections WHERE source_thread_id=?").run(input.sourceThreadId)).toThrow(/retained/);
    for (const patch of [{ requestKey: " " }, { requestHash: "not-a-hash" }, { sourceThreadId: " " }, { error: " " }]) {
      expect(() => teamForks.reject(db, { ...denied, ...patch })).toThrow(/bounded request identity/);
    }
    const accepted = teamForks.create(db, { ...input, requestKey: "new-intention" });
    expect(accepted.state).toBe("pending");
    expect(() => teamForks.reject(db, { ...denied, requestKey: accepted.requestKey })).toThrow(/admitted.*rejected/);
    expect(() =>
      db
        .stmt("INSERT INTO team_fork_rejections(source_thread_id,request_key,request_hash,error,created_at) VALUES(?,?,?,?,?)")
        .run(accepted.sourceThreadId, accepted.requestKey, accepted.requestHash, "Cannot reverse admission", Date.now()),
    ).toThrow(/admitted.*rejected/);
    expect(teamForks.get(db, accepted.id)).toEqual(accepted);
  });

  it("upgrades fixed version 19 without altering existing fork or context history and retains rejection after owner deletion", () => {
    const folder = mkdtempSync(join(tmpdir(), "openorc-fork-rejection-"));
    folders.push(folder);
    const file = join(folder, "fixture.sqlite"),
      raw = new DatabaseSync(file);
    for (const migration of migrations.slice(0, 19)) typeof migration === "string" ? raw.exec(migration) : migration(raw);
    raw.exec("PRAGMA user_version=19");
    const old = new Db(raw),
      f = fixture(old);
    const retained = teamForks.create(old, f.input);
    const context = teamContexts.create(old, {
      instanceId: f.instance.id,
      executionId: null,
      actorId: "lead",
      originExecutionId: null,
      reason: "compact",
      requestKey: "pre-upgrade-context",
      seed: "Preserve original context",
    });
    old.close();
    opened.delete(old);
    const db = Db.open(file);
    opened.add(db);
    expect(db.version).toBeGreaterThanOrEqual(20);
    expect(teamForks.get(db, retained.id)).toEqual(retained);
    expect(teamContexts.get(db, context.id)).toEqual(context);
    const denied = { sourceThreadId: f.source.id, requestKey: "rejected-after-upgrade", requestHash: "d".repeat(64), error: "Old checkpoint cannot be verified." };
    const receipt = teamForks.reject(db, denied);
    db.stmt("DELETE FROM projects WHERE id=?").run(f.project.id);
    db.close();
    opened.delete(db);
    const reopened = Db.open(file);
    opened.add(reopened);
    expect(teamForks.rejection(reopened, denied.sourceThreadId, denied.requestKey)).toEqual(receipt);
    expect(teamForks.reject(reopened, denied)).toEqual(receipt);
    expect(teamForks.get(reopened, retained.id)).toEqual(retained);
    expect(reopened.stmt("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("retains exact captured request identity, including requested cutoff versus selected run", () => {
    const { db, input } = fixture();
    const record = teamForks.create(db, input);
    expect(teamForks.create(db, input)).toEqual(record);
    expect(teamForks.find(db, input.sourceThreadId, input.requestKey)).toEqual(record);
    expect(teamForks.pendingForThread(db, input.sourceThreadId)).toEqual([record]);
    expect(teamForks.pendingForThread(db, input.destinationThreadId)).toEqual([record]);
    for (const patch of [
      { seed: "Changed" },
      { requestHash: "b".repeat(64) },
      { destinationThreadId: randomUUID() },
      { projectRoot: "/tmp/elsewhere" },
      { snapshot: { ...input.snapshot, treeSha: "4".repeat(40) } },
      { setupInput: { ...input.snapshot, treeSha: "5".repeat(40) } },
      { thread: { ...input.thread, permissionMode: "autonomous" as const } },
    ]) {
      expect(() => teamForks.create(db, { ...input, ...patch })).toThrow(/different captured work/);
    }
    expect(() => teamForks.create(db, { ...input, upToRunId: "different" })).toThrow(/matching cutoff/);
    expect(() => db.stmt("UPDATE team_forks SET captured_input=json_set(captured_input,'$.upToRunId','changed') WHERE id=?").run(record.id)).toThrow(/immutable/);
  });

  it("checks initial source/project/revision ownership without creating a destination", () => {
    const { db, input, source } = fixture(),
      foreign = fixture(db);
    for (const patch of [
      { sourceThreadId: foreign.source.id },
      { sourceInstanceId: foreign.instance.id },
      { projectId: foreign.project.id },
      { projectRoot: "/tmp/wrong" },
      { teamRevisionId: foreign.team.revision.id },
      { destinationThreadId: source.id },
      { sourceRunId: "unknown" },
    ]) {
      expect(() => teamForks.create(db, { ...input, ...patch })).toThrow(/source team/);
    }
    expect(teamForks.list(db)).toEqual([]);
    expect(threads.get(db, input.destinationThreadId)).toBeNull();
  });

  it("retains every uncertain candidate and requires a new unique path on recovery", () => {
    const { db, input } = fixture();
    let record = teamForks.create(db, input);
    record = teamForks.appendPath(db, record.id, "/tmp/first-fork-candidate");
    record = teamForks.attention(db, record.id, "Materialization interrupted");
    expect(() => teamForks.appendPath(db, record.id, record.paths[0]!)).toThrow(/new path/);
    record = teamForks.appendPath(db, record.id, "/tmp/second-fork-candidate");
    expect(record).toMatchObject({ state: "attention", error: "Materialization interrupted", paths: ["/tmp/first-fork-candidate", "/tmp/second-fork-candidate"] });
    const other = teamForks.create(db, { ...input, id: randomUUID(), requestKey: "another", destinationThreadId: randomUUID() });
    expect(() => teamForks.appendPath(db, other.id, record.paths[0]!)).toThrow(/new path/);
    for (const paths of [[], [record.paths[1]], [...record.paths].reverse(), [...record.paths, "/tmp/a", "/tmp/b"], [...record.paths, record.paths[0]]]) {
      expect(() => db.stmt("UPDATE team_forks SET paths=? WHERE id=?").run(JSON.stringify(paths), record.id)).toThrow(/immutable/);
    }
    expect(() => db.stmt("UPDATE team_forks SET paths=? WHERE id=?").run(JSON.stringify([record.paths[0]]), other.id)).toThrow(/immutable/);
    expect(() => db.stmt("DELETE FROM team_forks WHERE id=?").run(record.id)).toThrow(/retained/);
    expect(teamForks.get(db, record.id)).toEqual(record);
  });

  it("applies only an atomically created matching pinned destination and never an older candidate", () => {
    const { db, input } = fixture();
    const record = teamForks.create(db, input);
    teamForks.appendPath(db, record.id, "/tmp/old-candidate");
    teamForks.appendPath(db, record.id, "/tmp/new-candidate");
    expect(() => teamForks.apply(db, record.id, "/tmp/old-candidate")).toThrow(/newest/);
    expect(() => teamForks.apply(db, record.id, "/tmp/new-candidate")).toThrow(/pinned instance/);
    expect(() =>
      db.transaction(() => {
        destination(db, record, "/tmp/new-candidate", "Wrong context");
        teamForks.apply(db, record.id, "/tmp/new-candidate");
      }),
    ).toThrow(/exact origin/);
    expect(threads.get(db, record.destinationThreadId)).toBeNull();
    const applied = db.transaction(() => {
      destination(db, record, "/tmp/new-candidate");
      return teamForks.apply(db, record.id, "/tmp/new-candidate");
    });
    expect(applied).toMatchObject({ state: "applied", appliedPath: "/tmp/new-candidate", error: null });
    expect(teamForks.byDestinationThread(db, record.destinationThreadId)).toEqual(applied);
    expect(teamForks.pendingForThread(db, record.sourceThreadId)).toEqual([]);
    expect(teamForks.apply(db, record.id, "/tmp/new-candidate")).toEqual(applied);
    expect(() => teamForks.apply(db, record.id, "/tmp/old-candidate")).toThrow(/different workspace/);
    expect(() => teamForks.attention(db, record.id, "Late failure")).toThrow(/already applied/);
    expect(() => teamForks.appendPath(db, record.id, "/tmp/late")).toThrow(/already applied/);
    expect(() => db.stmt("UPDATE team_forks SET state='attention',applied_path=NULL,error='late' WHERE id=?").run(record.id)).toThrow(/immutable/);
  });

  it("upgrades existing instances and retains applied and pending cleanup manifests through owner deletion and reopen", () => {
    const folder = mkdtempSync(join(tmpdir(), "openorc-fork-journal-"));
    folders.push(folder);
    const file = join(folder, "fixture.sqlite"),
      raw = new DatabaseSync(file),
      prior = migrations.indexOf(teamForkMigration);
    expect(prior).toBeGreaterThan(0);
    for (const migration of migrations.slice(0, prior)) typeof migration === "string" ? raw.exec(migration) : migration(raw);
    raw.exec(`PRAGMA user_version=${prior}`);
    const old = new Db(raw),
      f = fixture(old);
    old.close();
    opened.delete(old);
    const db = Db.open(file);
    opened.add(db);
    f.input.setupInput = { ...f.input.snapshot, treeSha: "5".repeat(40), treeRef: "refs/openorc/forks/fixture/setup/tree", headRef: "refs/openorc/forks/fixture/setup/head" };
    const record = teamForks.create(db, f.input);
    teamForks.appendPath(db, record.id, "/tmp/applied-workspace");
    const applied = db.transaction(() => {
      destination(db, record, "/tmp/applied-workspace");
      return teamForks.apply(db, record.id, "/tmp/applied-workspace");
    });
    const pending = teamForks.create(db, { ...f.input, id: randomUUID(), requestKey: "interrupted", destinationThreadId: randomUUID() });
    teamForks.appendPath(db, pending.id, "/tmp/interrupted-workspace");
    teamForks.attention(db, pending.id, "Recover this directory");
    db.stmt("DELETE FROM projects WHERE id=?").run(f.project.id);
    db.close();
    opened.delete(db);
    const reopened = Db.open(file);
    opened.add(reopened);
    expect(teamForks.apply(reopened, applied.id, applied.appliedPath!)).toEqual(applied);
    expect(teamForks.create(reopened, f.input)).toEqual(applied);
    expect(teamForks.get(reopened, applied.id)?.setupInput).toEqual(f.input.setupInput);
    expect(teamForks.list(reopened)).toHaveLength(2);
    expect(teamForks.get(reopened, pending.id)).toMatchObject({ state: "attention", paths: ["/tmp/interrupted-workspace"] });
    expect(reopened.stmt("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rejects malformed destination settings, ownership and provenance without consuming the captured intent", () => {
    const { db, input, project, source } = fixture();
    const otherProject = fixture(db);
    const otherRevision = orchestration.save(db, {
      projectId: project.id,
      expectedRevisionId: null,
      draft: { name: "Other team", limits: DEFAULT_TEAM_LIMITS, members: [{ key: "lead", name: "Other", managerKey: null, responsibility: "Work", settings }] },
    });
    const record = teamForks.create(db, input),
      candidate = "/tmp/malformed-destination";
    const pending = teamForks.appendPath(db, record.id, candidate);
    for (const patch of [
      { agent: "claude" as const },
      { model: "other" },
      { effort: "low" },
      { fastMode: false },
      { mode: "plan" as const },
      { permissionMode: "autonomous" as const },
      { baseSha: "f".repeat(40) },
      { workspaceMode: "current" as const },
      { branch: "wrong-branch" },
    ])
      expect(() =>
        db.transaction(() => {
          destination(db, record, candidate);
          threads.update(db, record.destinationThreadId, patch);
          teamForks.apply(db, record.id, candidate);
        }),
      ).toThrow(/exact origin/);
    for (const fault of ["project", "revision", "overrides", "origin"] as const)
      expect(() =>
        db.transaction(() => {
          if (fault === "project") {
            threads.insert(db, { id: record.destinationThreadId, projectId: otherProject.project.id, ...record.thread, workspaceMode: "worktree" });
            threads.update(db, record.destinationThreadId, { worktreePath: candidate, baseSha: record.snapshot.headSha });
            orchestration.createInstance(db, { threadId: record.destinationThreadId, teamRevisionId: otherProject.team.revision.id });
          } else if (fault === "revision") {
            threads.insert(db, { id: record.destinationThreadId, projectId: project.id, ...record.thread, workspaceMode: "worktree" });
            threads.update(db, record.destinationThreadId, { worktreePath: candidate, baseSha: record.snapshot.headSha });
            const instance = orchestration.createInstance(db, { threadId: record.destinationThreadId, teamRevisionId: otherRevision.revision.id });
            teamOrigins.create(db, { instanceId: instance.id, sourceThreadId: source.id, sourceInstanceId: record.sourceInstanceId, sourceRunId: null, seed: record.seed });
          } else {
            const instance = destination(db, record, candidate, fault === "origin" ? "Different origin seed" : record.seed);
            if (fault === "overrides")
              orchestration.updateLeadOverrides(db, { threadId: record.destinationThreadId, expectedConfigurationVersion: instance.configurationVersion, leadOverrides: { effort: "low" } });
          }
          teamForks.apply(db, record.id, candidate);
        }),
      ).toThrow(/exact origin/);
    expect(teamForks.get(db, record.id)).toEqual(pending);
    expect(threads.get(db, record.destinationThreadId)).toBeNull();
    expect(db.stmt("SELECT count(*) AS n FROM team_origins").get()).toEqual({ n: 0 });
    expect(db.stmt("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
