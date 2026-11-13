import { claudeAccounts, Db, projects, runs, scheduleFirings, schedules, threads } from "@openorc/db";
import { type Project } from "@openorc/protocol";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduleService } from "./schedules.js";
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
let modelStart: ReturnType<typeof vi.fn<ThreadService["start"]>>;
let gate: ReturnType<typeof deferred> | null;
let afterAdmissionError: boolean;
let notifications: ReturnType<typeof vi.fn<ConstructorParameters<typeof ScheduleService>[3]>>;
let warnings: ReturnType<typeof vi.fn<(message: string) => void>>;
let invalidations: ReturnType<typeof vi.fn<(keys: string[]) => void>>;
function freshService(updating: (agent: string) => boolean = () => false) {
  return new ScheduleService(db, { start: modelStart }, invalidations, notifications, { info() {}, warn: warnings, error() {} }, { updating });
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
beforeEach(() => {
  folder = mkdtempSync(path.join(os.tmpdir(), "openorc-scheduling-"));
  db = Db.open(path.join(folder, "data.sqlite"));
  // Use a real repository for schedule workspace admission.
  const repository = path.join(folder, "repository");
  mkdirSync(repository);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repository });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repository });
  project = projects.insert(db, { name: "Scheduling fixture", rootPath: repository, defaultBranch: "main", gitRemote: null, settings: {} });
  gate = null;
  afterAdmissionError = false;
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

  it("coalesces one request and skips competing firings while preflight is pending", async () => {
    const schedule = modelSchedule();
    gate = deferred();
    const first = service.trigger(schedule.id, "one"),
      replay = service.trigger(schedule.id, "one");
    expect(first).toBe(replay);
    const competing = await service.trigger(schedule.id, "two");
    expect(competing).toMatchObject({ status: "skipped", reason: expect.stringContaining("being prepared") });
    gate.resolve();
    expect((await first).status).toBe("started");
    expect(modelStart).toHaveBeenCalledTimes(1);
    expect(await service.trigger(schedule.id, "two")).toEqual(competing);
  });

  it.each(["edit", "disable", "delete"] as const)("cancels %s during awaited preflight before creating a conversation", async (action) => {
    const schedule = modelSchedule();
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

  it("rechecks solo schedule edits after model preflight and before durable insertion", async () => {
    const schedule = modelSchedule();
    gate = deferred();
    const pending = service.trigger(schedule.id, "edit-solo");
    service.update(schedule.id, { prompt: "Different solo work" });
    gate.resolve();
    expect(await pending).toMatchObject({ status: "cancelled" });
    expect(threads.list(db, { projectId: project.id })).toHaveLength(0);
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
    const schedule = modelSchedule();
    gate = deferred();
    const pending = service.trigger(schedule.id, "shutdown");
    const closing = service.shutdown();
    expect(() => service.trigger(schedule.id, "too-late")).toThrow(/shutting down/);
    gate.resolve();
    await closing;
    expect(await pending).toMatchObject({ status: "cancelled", reason: expect.stringContaining("shutting down") });
    expect(threads.list(db, { projectId: project.id })).toHaveLength(0);
  });

  it("propagates explicit solo Fast settings", async () => {
    const schedule = service.create({ ...modelSchedule(), executionTarget: { kind: "model", settings: leadSettings } });
    expect((await service.trigger(schedule.id, "fast")).status).toBe("started");
    expect(modelStart).toHaveBeenCalledWith(expect.objectContaining({ fastMode: true, model: leadSettings.model, effort: "high" }), expect.anything());
  });
});

it("fires other agents' schedules on time during an agent's update, and that agent's own on the tick after it", async () => {
  let updating = "codex";
  service = freshService((agent) => agent === updating);
  const held = modelSchedule();
  const other = service.create({ ...modelSchedule(), title: "Scheduled on another agent", agent: "claude" });
  expect(schedules.get(db, held.id)?.agent).toBe("codex");
  const due = Date.now() - 1000;
  for (const schedule of [held, other]) schedules.update(db, schedule.id, { nextRunAt: due });
  await service.tick();
  expect(modelStart.mock.calls.map(([input]) => input.agent)).toEqual(["claude"]);
  expect(scheduleFirings.list(db, held.id)).toEqual([]);
  expect(schedules.get(db, held.id)?.nextRunAt).toBe(due);
  updating = "";
  await service.tick();
  expect(modelStart.mock.calls.map(([input]) => input.agent)).toEqual(["claude", "codex"]);
});

it("starts a schedule by hand during its agent's update", async () => {
  service = freshService(() => true);
  const schedule = modelSchedule();
  expect((await service.trigger(schedule.id, "during-update")).status).toBe("started");
  expect(modelStart).toHaveBeenCalledOnce();
});

describe("a project's own Claude accounts", () => {
  const claudeSchedule = (claudeAccountId?: string) =>
    service.create({
      projectId: project.id,
      title: "Scheduled Claude",
      prompt: "Check the project",
      agent: "claude",
      model: null,
      effort: null,
      mode: "plan",
      permissionMode: "trusted",
      workspaceMode: "current",
      everyMinutes: 30,
      ...(claudeAccountId ? { claudeAccountId } : {}),
    });
  const onlyUse = (accountIds: string[], defaultId: string) => projects.updateSettings(db, project.id, { claudeAccounts: { only: true, accountIds, defaultId, autoSwitch: false } });

  it("saves a schedule on an account the project uses, or its default, and refuses one it does not", () => {
    const [work, personal] = ["Work", "Personal"].map((name) => claudeAccounts.add(db, name).id) as [string, string];
    onlyUse([work], work);
    expect(claudeSchedule().claudeAccountId).toBe(work);
    expect(() => claudeSchedule(personal)).toThrow(/only uses these Claude accounts/);
    const saved = claudeSchedule(work);
    expect(() => service.update(saved.id, { claudeAccountId: personal })).toThrow(/only uses these Claude accounts/);
    expect(schedules.get(db, saved.id)?.claudeAccountId).toBe(work);
  });

  it("keeps firing on the project's default once the project stops using the schedule's account, and says so", async () => {
    const [work, personal] = ["Work", "Personal"].map((name) => claudeAccounts.add(db, name).id) as [string, string];
    const schedule = claudeSchedule(work);
    onlyUse([personal], personal);
    await service.trigger(schedule.id, "after-the-change");
    expect(modelStart).toHaveBeenCalledWith(expect.objectContaining({ claudeAccountId: personal }), expect.anything());
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining("runs on its project's default Claude account"));
    expect(schedules.get(db, schedule.id)?.claudeAccountId).toBe(work);
    // Said once, not at every firing.
    await service.trigger(schedule.id, "and-again");
    expect(modelStart).toHaveBeenCalledTimes(2);
    expect(warnings.mock.calls.filter(([message]) => message.includes("default Claude account"))).toHaveLength(1);
  });
});
