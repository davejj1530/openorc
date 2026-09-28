import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_TEAM_LIMITS, ScheduleLaunchSnapshot } from "@openorc/protocol";
import { Db } from "./database.js";
import { migrations } from "./schema.js";
import { projects, threads } from "./repos.js";
import { orchestration } from "./orchestration.js";
import { schedules, scheduleFirings } from "./schedules.js";
import { teamRuntime } from "./team-runtime.js";
import { randomUUID } from "node:crypto";

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
function fixture() {
  const db = Db.memory();
  opened.push(db);
  const project = projects.insert(db, { name: "Demo", rootPath: "/tmp/schedule-demo", gitRemote: null, defaultBranch: "main", settings: {} });
  const other = projects.insert(db, { name: "Other", rootPath: "/tmp/schedule-other", gitRemote: null, defaultBranch: "main", settings: {} });
  const input = {
    projectId: project.id,
    title: "Daily review",
    prompt: "Review the work",
    agent: "codex" as const,
    model: null,
    effort: null,
    mode: "plan" as const,
    permissionMode: "review" as const,
    workspaceMode: "worktree" as const,
    everyMinutes: 60,
  };
  const schedule = schedules.insert(db, input);
  const reserve = (key = "request-1") =>
    scheduleFirings.reserve(db, {
      scheduleId: schedule.id,
      requestKey: key,
      scheduleVersion: schedule.version,
      trigger: "manual",
      scheduledFor: null,
      snapshot: ScheduleLaunchSnapshot.parse(schedule),
    });
  const addThread = (projectId = project.id) => threads.insert(db, { projectId, title: "Scheduled review", agent: "codex", model: null, mode: "plan", permissionMode: "review" });
  return { db, project, other, input, schedule, reserve, addThread };
}

function teamFiring() {
  const f = fixture();
  const settings = { agent: "codex" as const, model: "fixture", effort: null, fastMode: false };
  const saved = orchestration.save(f.db, {
    projectId: f.project.id,
    expectedRevisionId: null,
    draft: {
      name: "Scheduled team",
      limits: DEFAULT_TEAM_LIMITS,
      members: [{ key: "lead", name: "Lead", managerKey: null, responsibility: "Review", settings }],
    },
  });
  const schedule = schedules.insert(f.db, { ...f.input, executionTarget: { kind: "team", teamRevisionId: saved.revision.id } });
  const thread = f.addThread();
  const instance = orchestration.createInstance(f.db, { threadId: thread.id, teamRevisionId: saved.revision.id });
  const execution = teamRuntime.create(f.db, {
    id: randomUUID(),
    threadId: thread.id,
    projectId: f.project.id,
    instanceId: instance.id,
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
        input: { title: "Review", spec: "Review", attachments: [], responsibility: "Review", settings },
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
    createdAt: 1,
    updatedAt: 1,
    deadlineAt: 1000,
  });
  const firing = scheduleFirings.reserve(f.db, {
    scheduleId: schedule.id,
    requestKey: "team-start",
    scheduleVersion: schedule.version,
    trigger: "manual",
    scheduledFor: null,
    snapshot: ScheduleLaunchSnapshot.parse(schedule),
  });
  return { ...f, schedule, thread, execution, firing };
}

describe("durable schedule launches", () => {
  it("upgrades legacy schedules with their exact provider default and cadence", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openorc-schedules-migrate-"));
    const file = path.join(dir, "old.sqlite"),
      raw = new DatabaseSync(file);
    for (const migration of migrations.slice(0, 14)) typeof migration === "string" ? raw.exec(migration) : migration(raw);
    raw.exec("PRAGMA user_version=14");
    const old = new Db(raw);
    const project = projects.insert(old, { name: "Legacy", rootPath: dir, gitRemote: null, defaultBranch: null, settings: {} });
    old
      .stmt(
        "INSERT INTO schedules (id,project_id,title,prompt,agent,model,effort,mode,permission_mode,workspace_mode,every_minutes,enabled,next_run_at,created_at,updated_at) VALUES ('legacy',?,'Review','Read','claude',NULL,NULL,'plan','review','current',90,0,12345,1,2)",
      )
      .run(project.id);
    old.close();
    const db = Db.open(file);
    try {
      expect(schedules.get(db, "legacy")).toMatchObject({
        agent: "claude",
        model: null,
        effort: null,
        executionTarget: null,
        version: 1,
        enabled: false,
        nextRunAt: 12345,
        createdAt: 1,
        updatedAt: 2,
      });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pins an immutable revision through edits and archival and enforces project ownership", () => {
    const { db, project, other, input } = fixture();
    const draft = {
      name: "Reviewers",
      limits: DEFAULT_TEAM_LIMITS,
      members: [{ key: "lead", name: "Lead", managerKey: null, responsibility: "Review the work", settings: { agent: "codex" as const, model: "gpt-6-astra", effort: "high", fastMode: false } }],
    };
    const saved = orchestration.save(db, { projectId: project.id, expectedRevisionId: null, draft });
    const target = { kind: "team" as const, teamRevisionId: saved.revision.id, initialLeadOverrides: { effort: "medium" } };
    const schedule = schedules.insert(db, { ...input, executionTarget: target });
    const next = orchestration.save(db, { projectId: project.id, teamId: saved.team.id, expectedRevisionId: saved.revision.id, draft: { ...draft, name: "Changed" } });
    orchestration.archive(db, { projectId: project.id, teamId: saved.team.id, expectedRevisionId: next.revision.id, archived: true });
    expect(schedules.get(db, schedule.id)).toMatchObject({ executionTarget: target, team: { revision: { id: saved.revision.id, name: "Reviewers" }, archived: true } });
    expect(() => schedules.insert(db, { ...input, projectId: other.id, executionTarget: target })).toThrow(/project/);
    expect(() => db.stmt("UPDATE schedules SET team_revision_id=NULL WHERE id=?").run(schedule.id)).toThrow(/pin/);
  });

  it("versions changed configuration but keeps no-ops and launch bookkeeping stable", () => {
    const { db, schedule, addThread } = fixture();
    expect(schedules.update(db, schedule.id, { expectedVersion: 1, title: schedule.title }).version).toBe(1);
    const thread = addThread();
    expect(schedules.update(db, schedule.id, { lastThreadId: thread.id, lastRunAt: 20, nextRunAt: 30 }).version).toBe(1);
    expect(schedules.update(db, schedule.id, { expectedVersion: 1, enabled: false, title: "New" }).version).toBe(2);
    expect(() => schedules.update(db, schedule.id, { expectedVersion: 1, prompt: "Stale" })).toThrow(/another window/);
    expect(schedules.get(db, schedule.id)?.prompt).toBe(schedule.prompt);
  });

  it("retains the captured input and only settles once", () => {
    const { db, schedule, reserve, addThread } = fixture();
    const firing = reserve(),
      thread = addThread();
    expect(reserve().id).toBe(firing.id);
    schedules.update(db, schedule.id, { title: "New title" });
    expect(scheduleFirings.findRequest(db, schedule.id, "request-1")?.snapshot.title).toBe("Daily review");
    const result = scheduleFirings.settle(db, firing.id, { state: "started", threadId: thread.id });
    expect(scheduleFirings.settle(db, firing.id, { state: "started", threadId: thread.id })).toEqual(result);
    expect(() => scheduleFirings.settle(db, firing.id, { state: "failed", reason: "Changed" })).toThrow(/different result/);
    expect(() => db.stmt("UPDATE schedule_firings SET snapshot='{}' WHERE id=?").run(firing.id)).toThrow(/immutable/);
    expect(() => db.stmt("DELETE FROM schedule_firings WHERE id=?").run(firing.id)).toThrow(/retained/);
    expect(schedules.get(db, schedule.id)?.lastFire).toMatchObject({ id: firing.id, state: "started", threadId: thread.id });
  });

  it("rejects changed input reusing a request key and stale reservations", () => {
    const { db, schedule, reserve } = fixture();
    reserve();
    const input = {
      scheduleId: schedule.id,
      requestKey: "request-1",
      scheduleVersion: 1,
      trigger: "manual" as const,
      scheduledFor: null,
      snapshot: { ...ScheduleLaunchSnapshot.parse(schedule), prompt: "Different" },
    };
    expect(() => scheduleFirings.reserve(db, input)).toThrow(/different launch/);
    expect(() => scheduleFirings.reserve(db, { ...input, requestKey: "new" })).toThrow(/changed/);
  });

  it("rolls thread admission and launch receipt back together", () => {
    const { db, reserve, addThread } = fixture();
    const firing = reserve();
    expect(() =>
      db.transaction(() => {
        const thread = addThread();
        scheduleFirings.settle(db, firing.id, { state: "started", threadId: thread.id });
        throw new Error("Atomic admission cancelled");
      }),
    ).toThrow(/cancelled/);
    expect(threads.list(db)).toHaveLength(0);
    expect(scheduleFirings.get(db, firing.id)?.state).toBe("pending");
  });

  it.each(["thread", "project"] as const)("allows the actual owning %s cascade to clear both team launch foreign keys", (owner) => {
    const { db, project, firing, thread, execution } = teamFiring();
    scheduleFirings.settle(db, firing.id, { state: "started", threadId: thread.id, executionId: execution.id });
    db.stmt(owner === "thread" ? "DELETE FROM threads WHERE id=?" : "DELETE FROM projects WHERE id=?").run(owner === "thread" ? thread.id : project.id);
    expect(teamRuntime.get(db, execution.id)).toBeNull();
    if (owner === "thread") expect(scheduleFirings.get(db, firing.id)).toMatchObject({ state: "started", threadId: null, executionId: null });
    else expect(scheduleFirings.get(db, firing.id)).toBeNull();
    expect(db.stmt("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("keeps a deleted thread's consumed receipt and allows schedule/project cleanup", () => {
    const { db, project, schedule, reserve, addThread } = fixture();
    const firing = reserve(),
      thread = addThread();
    scheduleFirings.settle(db, firing.id, { state: "started", threadId: thread.id });
    db.stmt("DELETE FROM threads WHERE id=?").run(thread.id);
    expect(scheduleFirings.get(db, firing.id)).toMatchObject({ state: "started", threadId: null });
    schedules.delete(db, schedule.id);
    expect(scheduleFirings.get(db, firing.id)).toBeNull();
    db.stmt("DELETE FROM projects WHERE id=?").run(project.id);
    expect(db.stmt("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
