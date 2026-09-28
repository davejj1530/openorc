import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Db, orchestration, projects, runs, scheduleFirings, schedules, teamRuntime, threads } from "@openorc/db";
import { DEFAULT_TEAM_LIMITS, ScheduleLaunchSnapshot, type Project, type TeamExecutionRecord, type Thread } from "@openorc/protocol";
import { ScheduleService } from "./schedules.js";
import { TeamConversationService } from "./team-conversation.js";
import type { TeamCoordinator, TeamStartPlan } from "./team-coordinator.js";
import type { AppSettingsService } from "./settings.js";
import type { RunService } from "./runs.js";
import type { ThreadService } from "./threads.js";

const leadSettings = { agent: "codex" as const, model: "fixture-astra", effort: "high", fastMode: true };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let db: Db;
let folder: string;
let project: Project;
let service: ScheduleService;
let teamService: TeamConversationService;
let modelStart: ReturnType<typeof vi.fn<ThreadService["start"]>>;
let validate: ReturnType<typeof vi.fn<TeamCoordinator["validateStart"]>>;
let gate: ReturnType<typeof deferred> | null;
let enabled: boolean;
let afterAdmissionError: boolean;
let reasons: Map<string, string>;
let notifications: ReturnType<typeof vi.fn<ConstructorParameters<typeof ScheduleService>[3]>>;
let warnings: ReturnType<typeof vi.fn<(message: string) => void>>;
let invalidations: ReturnType<typeof vi.fn<(keys: string[]) => void>>;
let saved: ReturnType<typeof orchestration.save>;

function execution(thread: Thread, plan: TeamStartPlan, prompt: string, admission?: TeamExecutionRecord["admission"]) {
  const instance = orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: plan.revision.id, initialLeadOverrides: plan.leadOverrides }, { allowArchived: plan.allowArchived });
  const lead = plan.revision.members.find((member) => member.managerKey === null)!;
  const now = Date.now();
  return teamRuntime.create(db, {
    id: randomUUID(),
    instanceId: instance.id,
    projectId: project.id,
    threadId: thread.id,
    state: "active",
    generation: 1,
    revision: 0,
    limits: plan.revision.limits,
    actors: [
      {
        id: "lead",
        memberKey: lead.key,
        taskId: null,
        parentId: null,
        requestKey: null,
        requestHash: null,
        dependencies: [],
        input: { title: thread.title, spec: prompt, attachments: [], responsibility: lead.responsibility, settings: plan.settings },
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
    ...(admission ? { admission } : {}),
    error: null,
    createdAt: now,
    updatedAt: now,
    deadlineAt: now + 3600000,
  });
}
function freshService(maintenance = () => false) {
  return new ScheduleService(
    db,
    { start: modelStart },
    invalidations,
    notifications,
    { info() {}, warn: warnings, error() {} },
    {
      maintenance,
      teams: teamService,
      teamQuiescenceReason: (threadId) => reasons.get(threadId) ?? (teamRuntime.activeForThread(db, threadId) ? "The team has unfinished assignments." : null),
    },
  );
}
function modelSchedule() {
  return service.create({
    projectId: project.id,
    title: "Scheduled solo",
    prompt: "Check the project",
    agent: "codex",
    model: null,
    effort: null,
    mode: "plan",
    permissionMode: "trusted",
    workspaceMode: "current",
    everyMinutes: 30,
  });
}
function teamSchedule() {
  return service.create({
    projectId: project.id,
    title: "Scheduled team",
    prompt: "Implement and review",
    executionTarget: {
      kind: "team",
      teamRevisionId: saved.revision.id,
      initialLeadOverrides: { effort: "medium", fastMode: false },
    },
    mode: "act",
    permissionMode: "trusted",
    workspaceMode: "current",
    everyMinutes: 30,
  });
}
function complete(threadId: string) {
  const active = teamRuntime.activeForThread(db, threadId)!;
  teamRuntime.update(db, active.id, (record) => {
    record.state = "completed";
    record.actors[0]!.state = "completed";
  });
}
beforeEach(() => {
  folder = mkdtempSync(path.join(os.tmpdir(), "openorc-scheduling-"));
  db = Db.open(path.join(folder, "data.sqlite"));
  project = projects.insert(db, { name: "Scheduling fixture", rootPath: path.join(folder, "repository"), defaultBranch: "main", gitRemote: null, settings: {} });
  saved = orchestration.save(db, {
    projectId: project.id,
    expectedRevisionId: null,
    draft: {
      name: "Scheduled team",
      limits: { ...DEFAULT_TEAM_LIMITS },
      discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
      members: [
        { key: "lead", name: "Lead", responsibility: "Coordinate work", managerKey: null, settings: leadSettings },
        { key: "reviewer", name: "Reviewer", responsibility: "Review independently", managerKey: "lead", settings: { ...leadSettings, agent: "claude", model: "fixture-fable" } },
      ],
    },
  });
  gate = null;
  enabled = true;
  afterAdmissionError = false;
  reasons = new Map();
  notifications = vi.fn();
  warnings = vi.fn();
  invalidations = vi.fn();
  modelStart = vi.fn(async (input, internal) => {
    if (gate) await gate.promise;
    const thread = db.transaction(() => {
      internal?.assertCanAdmit();
      const created = threads.insert(db, {
        projectId: input.projectId,
        title: input.title!,
        agent: input.agent,
        model: input.model ?? null,
        effort: input.effort ?? null,
        fastMode: input.fastMode,
        mode: input.mode,
        permissionMode: input.permissionMode,
        workspaceMode: input.workspaceMode,
      });
      internal?.onAdmitted(created);
      return created;
    });
    if (afterAdmissionError) throw new Error("Scripted setup failure after durable admission");
    return {
      thread,
      run: runs.insert(db, {
        id: randomUUID(),
        threadId: thread.id,
        taskId: null,
        agent: thread.agent,
        model: thread.model,
        effort: thread.effort,
        mode: thread.mode,
        permissionMode: thread.permissionMode,
      }),
    };
  });
  validate = vi.fn(async (input) => {
    if (gate) await gate.promise;
    const revision = orchestration.getRevision(db, input.teamRevisionId)!;
    const settings = { ...revision.members[0]!.settings, ...input.leadOverrides };
    return { revision, settings, leadOverrides: input.leadOverrides ?? {}, allowArchived: input.allowArchived };
  });
  const coordinator = {
    validateStart: validate,
    admit: (input: Parameters<TeamCoordinator["admit"]>[0]) => execution(threads.get(db, input.threadId)!, input.plan, input.prompt, input.admission),
  } as unknown as TeamCoordinator;
  teamService = new TeamConversationService(db, coordinator, {} as RunService, { get: () => ({ experimentalTeamExecution: enabled }) } as AppSettingsService, invalidations, () => null);
  service = freshService();
});
afterEach(async () => {
  gate?.resolve();
  await service.shutdown();
  db.close();
  rmSync(folder, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("durable scheduled launches", () => {
  it("preserves legacy and explicit Astra Max settings on save and launch", async () => {
    const original = modelSchedule();
    const legacy = service.update(original.id, { model: "gpt-6-astra", effort: "max" });
    expect(legacy.effort).toBe("max");
    const explicit = service.update(original.id, { executionTarget: { kind: "model", settings: { agent: "codex", model: "gpt-6-astra", effort: "max", fastMode: false } } });
    expect(explicit.executionTarget).toMatchObject({ settings: { effort: "max" } });
    await service.trigger(original.id, "astra-correction");
    expect(modelStart).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-6-astra", effort: "max" }), expect.anything());
  });
  it("preserves legacy fire coalescing and journals accepted solo launches", async () => {
    const schedule = modelSchedule();
    gate = deferred();
    const first = service.fire(schedule),
      second = service.fire(schedule);
    expect(service.hasPendingWork).toBe(true);
    expect(modelStart).toHaveBeenCalledTimes(1);
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(service.hasPendingWork).toBe(false);
    expect(a.id).toBe(b.id);
    expect(schedules.get(db, schedule.id)?.lastThreadId).toBe(a.id);
    expect(scheduleFirings.list(db, schedule.id)).toHaveLength(1);
    expect(notifications).toHaveBeenCalledTimes(1);
  });

  it("pins the revision and explicit lead settings across template edits and archive", async () => {
    const schedule = teamSchedule();
    expect(schedule.workspaceMode).toBe("worktree");
    const revised = orchestration.save(db, {
      projectId: project.id,
      teamId: saved.team.id,
      expectedRevisionId: saved.revision.id,
      draft: {
        limits: saved.revision.limits,
        discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
        name: "Later version",
        members: saved.revision.members.map((member) => ({ ...member, settings: { ...member.settings, model: "later-model" } })),
      },
    });
    orchestration.archive(db, { projectId: project.id, teamId: saved.team.id, expectedRevisionId: revised.revision.id, archived: true });
    expect(() => teamSchedule()).toThrow(/archived/);
    expect(service.update(schedule.id, { title: "Retained archived pin" }).team?.archived).toBe(true);
    const fired = await service.trigger(schedule.id, "archived-pin");
    expect(fired.status).toBe("started");
    if (fired.status !== "started") throw new Error(fired.reason);
    expect(orchestration.getInstance(db, fired.thread.id)).toMatchObject({ teamRevisionId: saved.revision.id, leadOverrides: { effort: "medium", fastMode: false } });
    expect(fired.thread).toMatchObject({ model: leadSettings.model, effort: "medium", fastMode: false, workspaceMode: "worktree" });
    expect(validate).toHaveBeenCalledWith(expect.objectContaining({ teamRevisionId: saved.revision.id, allowArchived: true }));
    expect(service.list()[0]?.team?.revision.id).toBe(saved.revision.id);
    expect(modelStart).not.toHaveBeenCalled();
  });

  it("coalesces one request and skips competing firings while preflight is pending", async () => {
    const schedule = teamSchedule();
    gate = deferred();
    const first = service.trigger(schedule.id, "one"),
      replay = service.trigger(schedule.id, "one");
    expect(first).toBe(replay);
    const competing = await service.trigger(schedule.id, "two");
    expect(competing).toMatchObject({ status: "skipped", reason: expect.stringContaining("being prepared") });
    gate.resolve();
    expect((await first).status).toBe("started");
    expect(validate).toHaveBeenCalledTimes(1);
    expect(await service.trigger(schedule.id, "two")).toEqual(competing);
  });

  it("checks all prior team conversations after restart, including later work and publication barriers", async () => {
    const schedule = teamSchedule();
    const first = await service.trigger(schedule.id, "first");
    if (first.status !== "started") throw new Error(first.reason);
    complete(first.thread.id);
    const second = await service.trigger(schedule.id, "second");
    if (second.status !== "started") throw new Error(second.reason);
    complete(second.thread.id);
    reasons.set(first.thread.id, "A child publication is awaiting recovery.");
    service = freshService();
    const blocked = await service.trigger(schedule.id, "blocked-by-first");
    expect(blocked).toMatchObject({ status: "skipped", reason: expect.stringContaining("publication") });
    expect(schedules.get(db, schedule.id)?.lastThreadId).toBe(second.thread.id);
    reasons.delete(first.thread.id);
    expect((await service.trigger(schedule.id, "after-recovery")).status).toBe("started");
    expect(validate).toHaveBeenCalledTimes(3);
  });

  it("still checks an earlier team after changing the schedule to a solo model", async () => {
    const schedule = teamSchedule();
    expect((await service.trigger(schedule.id, "team")).status).toBe("started");
    service.update(schedule.id, { executionTarget: null, agent: "codex", model: null, effort: null });
    expect((await service.trigger(schedule.id, "solo")).status).toBe("skipped");
    expect(modelStart).not.toHaveBeenCalled();
  });

  it.each(["edit", "disable", "delete"] as const)("cancels %s during awaited preflight before creating a conversation", async (action) => {
    const schedule = teamSchedule();
    gate = deferred();
    const firing = service.trigger(schedule.id, `during-${action}`);
    if (action === "delete") service.delete(schedule.id);
    else service.update(schedule.id, action === "edit" ? { prompt: "Replacement work" } : { enabled: false });
    const afterEdit = schedules.get(db, schedule.id);
    gate.resolve();
    expect(await firing).toMatchObject({ status: "cancelled" });
    expect(threads.list(db, { projectId: project.id })).toHaveLength(0);
    expect(schedules.get(db, schedule.id)?.nextRunAt).toBe(afterEdit?.nextRunAt);
  });

  it("recovers a pending durable receipt once after close and reopen", async () => {
    const schedule = teamSchedule();
    const retained = scheduleFirings.reserve(db, {
      scheduleId: schedule.id,
      scheduleVersion: schedule.version,
      requestKey: "crashed-before-admission",
      trigger: "manual",
      scheduledFor: null,
      snapshot: ScheduleLaunchSnapshot.parse(schedule),
    });
    db.close();
    db = Db.open(path.join(folder, "data.sqlite"));
    // Services retain their own DB connection, as they do during a real restart.
    const coordinator = {
      validateStart: validate,
      admit: (input: Parameters<TeamCoordinator["admit"]>[0]) => execution(threads.get(db, input.threadId)!, input.plan, input.prompt, input.admission),
    } as unknown as TeamCoordinator;
    teamService = new TeamConversationService(db, coordinator, {} as RunService, { get: () => ({ experimentalTeamExecution: enabled }) } as AppSettingsService, invalidations, () => null);
    service = freshService();
    await Promise.all([service.tick(), service.tick()]);
    expect(scheduleFirings.get(db, retained.id)?.state).toBe("started");
    expect(validate).toHaveBeenCalledTimes(1);
    expect(threads.list(db, { projectId: project.id })).toHaveLength(1);
    expect((await service.trigger(schedule.id, "crashed-before-admission")).status).toBe("started");
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it("keeps the oldest pending firing's admission priority after restart", async () => {
    const schedule = teamSchedule();
    for (const requestKey of ["older", "newer"])
      scheduleFirings.reserve(db, { scheduleId: schedule.id, scheduleVersion: schedule.version, requestKey, trigger: "manual", scheduledFor: null, snapshot: ScheduleLaunchSnapshot.parse(schedule) });
    await service.tick();
    expect(scheduleFirings.findRequest(db, schedule.id, "older")?.state).toBe("started");
    expect(scheduleFirings.findRequest(db, schedule.id, "newer")?.state).toBe("skipped");
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it("rolls back team admission if its durable schedule receipt cannot commit", async () => {
    const schedule = teamSchedule();
    const settle = scheduleFirings.settle;
    vi.spyOn(scheduleFirings, "settle").mockImplementationOnce((...args) => {
      settle(...args);
      throw new Error("Scripted receipt failure");
    });
    expect(await service.trigger(schedule.id, "receipt-rollback")).toMatchObject({ status: "failed", reason: "Scripted receipt failure" });
    expect(threads.list(db, { projectId: project.id })).toHaveLength(0);
    expect(teamRuntime.listOpen(db)).toHaveLength(0);
    expect(schedules.get(db, schedule.id)?.lastThreadId).toBeNull();
    expect(notifications).not.toHaveBeenCalled();
  });

  it("rechecks solo schedule edits after model preflight and before durable insertion", async () => {
    const schedule = modelSchedule();
    gate = deferred();
    const pending = service.trigger(schedule.id, "edit-solo");
    service.update(schedule.id, { prompt: "Different solo work" });
    gate.resolve();
    expect(await pending).toMatchObject({ status: "cancelled" });
    expect(threads.list(db, { projectId: project.id })).toHaveLength(0);
  });

  it("advances skipped automatic cadence without changing cadence on manual overlap", async () => {
    const schedule = teamSchedule();
    await service.trigger(schedule.id, "active");
    schedules.update(db, schedule.id, { nextRunAt: Date.now() - 1000 });
    const before = schedules.get(db, schedule.id)!;
    expect((await service.trigger(schedule.id, "manual-overlap")).status).toBe("skipped");
    expect(schedules.get(db, schedule.id)?.nextRunAt).toBe(before.nextRunAt);
    await Promise.all([service.tick(), service.tick()]);
    expect(schedules.get(db, schedule.id)!.nextRunAt).toBeGreaterThan(Date.now());
    expect(scheduleFirings.list(db, schedule.id).filter((item) => item.trigger === "timer")).toHaveLength(1);
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it("does not launch a stale due-list entry after a manual firing resets its cadence", async () => {
    const first = modelSchedule(),
      second = modelSchedule();
    schedules.update(db, first.id, { nextRunAt: Date.now() - 2000 });
    schedules.update(db, second.id, { nextRunAt: Date.now() - 1000 });
    const held = deferred();
    gate = held;
    const ticking = service.tick();
    gate = null;
    expect((await service.trigger(second.id, "manual-resets-cadence")).status).toBe("started");
    held.resolve();
    await ticking;
    expect(modelStart).toHaveBeenCalledTimes(2);
    expect(scheduleFirings.list(db, second.id)).toEqual([expect.objectContaining({ trigger: "manual", state: "started" })]);
  });

  it("closes schedule admission before shutdown drains pending preflight", async () => {
    const schedule = teamSchedule();
    gate = deferred();
    const pending = service.trigger(schedule.id, "shutdown");
    const closing = service.shutdown();
    expect(() => service.trigger(schedule.id, "too-late")).toThrow(/shutting down/);
    gate.resolve();
    await closing;
    expect(await pending).toMatchObject({ status: "cancelled", reason: expect.stringContaining("shutting down") });
    expect(threads.list(db, { projectId: project.id })).toHaveLength(0);
  });

  it("propagates explicit solo Fast settings and isolates cross-project team selection", async () => {
    const schedule = service.create({ ...modelSchedule(), executionTarget: { kind: "model", settings: leadSettings } });
    expect((await service.trigger(schedule.id, "fast")).status).toBe("started");
    expect(modelStart).toHaveBeenCalledWith(expect.objectContaining({ fastMode: true, model: leadSettings.model, effort: "high" }), expect.anything());
    const other = projects.insert(db, { name: "Other", rootPath: path.join(folder, "other"), defaultBranch: "main", gitRemote: null, settings: {} });
    expect(() => service.create({ ...teamSchedule(), projectId: other.id })).toThrow(/this project/);
  });
});

it("leaves due firings untouched during agent updates and resumes after maintenance", async () => {
  let updating = true;
  service = freshService(() => updating);
  const schedule = modelSchedule();
  const due = Date.now() - 1000;
  schedules.update(db, schedule.id, { nextRunAt: due });
  await service.tick();
  expect(modelStart).not.toHaveBeenCalled();
  expect(scheduleFirings.list(db, schedule.id)).toEqual([]);
  expect(schedules.get(db, schedule.id)?.nextRunAt).toBe(due);
  expect(() => service.trigger(schedule.id, "during-update")).toThrow("agent update is running");
  updating = false;
  await service.tick();
  expect(modelStart).toHaveBeenCalledTimes(1);
});
