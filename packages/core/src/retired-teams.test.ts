import { messages, projects, runs, scheduleFirings, schedules, tasks, threads } from "@openorc/db";
import { ExecutionTarget, ScheduleLaunchSnapshot } from "@openorc/protocol";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { seedRetiredTeam } from "../../db/src/fixtures/retired-team.js";
import { OpenOrc } from "./openorc.js";

let folder: string;
let core: OpenOrc;
beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "openorc-retired-"));
  core = await OpenOrc.create({ dataDir: path.join(folder, "data"), ephemeral: true, transport: { push() {} } });
});
afterEach(async () => {
  await core?.close();
  vi.restoreAllMocks();
  await rm(folder, { recursive: true, force: true });
});

it("removes team RPC and launch targets", async () => {
  expect(ExecutionTarget.safeParse({ kind: "team", teamRevisionId: "saved" }).success).toBe(false);
  const reply = await core.handle({ type: "rpc", id: 1, method: "orchestration.list", params: {} });
  expect(reply).toMatchObject({ type: "rpc.error", message: "unknown method orchestration.list" });
});

it("hides retired work from inventories, search, old links and schedules without deleting files", async () => {
  const project = projects.insert(core.db, { name: "Saved", rootPath: folder, gitRemote: null, defaultBranch: null, settings: {} });
  const thread = threads.insert(core.db, { projectId: project.id, title: "Saved team", agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted" });
  const { revisionId } = seedRetiredTeam(core.db, thread);
  const task = tasks.insert(core.db, {
    projectId: project.id,
    threadId: thread.id,
    title: "Saved task",
    spec: "Keep the result",
    priority: "none",
    labels: [],
    workspaceMode: "current",
    baseRef: null,
    parentTaskId: null,
  });
  const start = vi.spyOn(core.runs, "start");
  expect(core.threads.get(thread.id)).toBeNull();
  const normal = threads.insert(core.db, { projectId: project.id, title: "Current work", agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted" });
  const child = threads.insert(core.db, { projectId: project.id, title: "Old subagent", agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted" });
  threads.update(core.db, child.id, { parentThreadId: thread.id });
  const ordinaryTask = tasks.insert(core.db, {
    projectId: project.id,
    threadId: normal.id,
    title: "Current task",
    spec: "Visible",
    priority: "none",
    labels: [],
    workspaceMode: "current",
    baseRef: null,
    parentTaskId: null,
  });
  const nestedTask = tasks.insert(core.db, {
    projectId: project.id,
    threadId: child.id,
    title: "Old child task",
    spec: "Hidden",
    priority: "none",
    labels: [],
    workspaceMode: "current",
    baseRef: null,
    parentTaskId: null,
  });
  tasks.update(core.db, task.id, { status: "review" });
  for (const [id, owner] of [
    ["old-run", thread],
    ["new-run", normal],
  ] as const) {
    runs.insert(core.db, { id, taskId: null, threadId: owner.id, agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted" });
    core.ledger.push({ type: "message.completed", runId: id, ts: 1, messageId: `${id}-message`, role: "assistant", text: "unique searchable result" });
    messages.index(core.db, { runId: id, messageId: `${id}-message`, role: "assistant", text: "unique searchable result", ts: 1 });
  }
  for (const [method, params, result] of [
    ["events.listForRun", { runId: "old-run" }, []],
    ["events.page", { runId: "old-run" }, { events: [], fromTurn: 0, live: false }],
    ["events.toolOutput", { runId: "old-run", toolCallId: "saved" }, { output: null }],
  ] as const) {
    expect(await core.handle({ type: "rpc", id: 3, method, params })).toMatchObject({ type: "rpc.result", result });
  }
  expect(await core.handle({ type: "rpc", id: 4, method: "events.page", params: { runId: "new-run" } })).toMatchObject({
    type: "rpc.result",
    result: { events: [expect.objectContaining({ text: "unique searchable result" })] },
  });
  expect(core.threads.get(child.id)).toBeNull();
  expect(core.threads.list({ projectId: project.id, filter: "all", limit: 1 }).map((item) => item.id)).toEqual([normal.id]);
  expect(core.threads.search("unique", { projectId: project.id, limit: 1 }).map((item) => item.threadId)).toEqual([normal.id]);
  expect(core.threads.messages(thread.id)).toEqual([]);
  expect(core.threads.conversationRuns(thread.id)).toEqual([]);
  expect(tasks.list(core.db, { projectId: project.id }).map((item) => item.id)).toEqual([ordinaryTask.id]);
  expect(await core.handle({ type: "rpc", id: 1, method: "tasks.get", params: { id: task.id } })).toMatchObject({ type: "rpc.result", result: null });
  expect(await core.handle({ type: "rpc", id: 1, method: "inbox.list", params: {} })).toMatchObject({ type: "rpc.result", result: { items: [] } });
  expect(tasks.get(core.db, task.id)?.retiredTeam).toBe(true);
  expect(await core.handle({ type: "rpc", id: 1, method: "tasks.get", params: { id: nestedTask.id } })).toMatchObject({ type: "rpc.result", result: null });
  expect(core.threads.executionThreadFor(task.id)).toBeNull();
  expect(await core.threads.toolGet("new-run", task.id)).toBeNull();
  expect(await core.handle({ type: "rpc", id: 1, method: "review.comments.list", params: { taskId: task.id } })).toMatchObject({ type: "rpc.result", result: [] });
  for (const [method, params] of [
    ["runs.start", { threadId: thread.id, agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted", prompt: "Run" }],
    ["threads.update", { id: thread.id, patch: { mode: "plan" } }],
    ["threads.update", { id: child.id, patch: { title: "Reopen" } }],
    ["threads.queue", { id: thread.id, text: "Run", requestKey: "new" }],
    ["threads.fork", { id: thread.id }],
    ["threads.delete", { id: thread.id }],
    ["threads.moveWorkspace", { id: thread.id, to: "worktree" }],
    ["tasks.openThread", { taskId: task.id }],
    ["tasks.update", { id: task.id, patch: { status: "archived" } }],
    ["tasks.delete", { id: task.id }],
    ["workspace.cleanup", { taskId: task.id }],
    ["tasks.prepareWorkspace", { taskId: task.id }],
  ] as const) {
    const result = await core.handle({ type: "rpc", id: 2, method, params });
    expect(result, method).toMatchObject({ type: "rpc.error", message: expect.stringMatching(/no longer available|not found/i) });
  }
  expect(start).not.toHaveBeenCalled();
  expect(threads.get(core.db, thread.id)?.title).toBe("Saved team");
  expect(tasks.get(core.db, task.id)?.spec).toBe("Keep the result");
  const schedule = core.schedules.create({
    projectId: project.id,
    title: "Saved schedule",
    prompt: "Run",
    agent: "codex",
    model: "fixture",
    mode: "act",
    permissionMode: "trusted",
    workspaceMode: "current",
    everyMinutes: 60,
  });
  core.db.stmt("UPDATE schedules SET execution_target=?, team_revision_id=?, enabled=0 WHERE id=?").run(JSON.stringify({ kind: "team", teamRevisionId: revisionId }), revisionId, schedule.id);
  expect(core.schedules.list(project.id)).toEqual([]);
  expect(() => core.schedules.trigger(schedule.id, "retry")).toThrow(/not found/i);
  expect(() => core.schedules.update(schedule.id, { enabled: true })).toThrow(/not found/i);
  const pending = scheduleFirings.reserve(core.db, {
    scheduleId: schedule.id,
    scheduleVersion: schedule.version,
    requestKey: "saved-pending",
    trigger: "manual",
    scheduledFor: null,
    snapshot: ScheduleLaunchSnapshot.parse(schedule),
  });
  await core.schedules.tick();
  expect(scheduleFirings.get(core.db, pending.id)).toMatchObject({ state: "cancelled", reason: expect.stringMatching(/no longer available|not found/i) });
  expect(start).not.toHaveBeenCalled();
  expect(schedules.get(core.db, schedule.id)).toMatchObject({ retiredTeam: true, enabled: false });
});
