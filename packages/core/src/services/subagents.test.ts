import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RunHandle } from "@openorc/agents";
import { Db, LedgerWriter, listEvents, projects, runs, subagents, threads, tasks } from "@openorc/db";
import type { AgentEvent, Frame, RunSpec } from "@openorc/protocol";
import { FrameCoalescer } from "../frames.js";
import { RunService, type RunHooks } from "./runs.js";
import { ThreadService } from "./threads.js";
import { WorkspaceService } from "./workspace.js";
import { WorkspaceWriters } from "./workspace-writers.js";
import { ShellEnvironment } from "./shell-environment.js";
import { CodexSubagents } from "../../../agents/src/codex/subagents.js";
import codexFixture from "../../../agents/src/codex/test-fixtures/subagents.json";
import { ClaudeStreamParser } from "../../../agents/src/claude/stream-json.js";
import workflowFixture from "../../../agents/src/claude/test-fixtures/workflows.json";
import forkedSkill from "../../../agents/src/claude/test-fixtures/forked-skill.json";
import { RunApprovals } from "./run-approvals.js";

const quiet = { info() {}, warn() {}, error() {} };
const settings = { agent: "codex", model: "fixture", mode: "act", permissionMode: "autonomous" } as const;
let fixture: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "openorc-subagents-"));
  const db = Db.memory();
  const ledger = new LedgerWriter(db);
  const project = projects.insert(db, { name: "Subagents", rootPath: root, gitRemote: null, defaultBranch: null, settings: {} });
  const parent = threads.insert(db, { projectId: project.id, title: "Parent", ...settings });
  const stop = vi.fn(async (_id: string) => {});
  const send = vi.fn(async () => {});
  const handles = new Map<string, RunHandle>();
  const start = vi.fn((spec: RunSpec) => {
    let finish!: (code: number) => void;
    const done = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const handle = new RunHandle(spec.runId, {
      send,
      stopSubagent: stop,
      interrupt() {},
      close() {
        finish(0);
      },
      done,
    });
    handles.set(spec.runId, handle);
    return handle;
  });
  const environment = new ShellEnvironment({ env: { ...process.env, OPENORC_CODEX_BIN: "/fixture/codex" } });
  const hooks: RunHooks = {
    environment: () => environment.current(),
    brief: () => "",
    onRunFinished() {},
    onThreadTurn() {},
    notify() {},
    claudeVersion: async () => null,
    onTurnSettled: vi.fn(),
    idleTimeoutMs: () => 100,
    onThreadIdle: vi.fn(),
  };
  const mcp = async () => ({ port: 0, urlForRun: (id: string) => `http://fixture.invalid/${id}`, revoke() {}, close: async () => {} });
  const writers = new WorkspaceWriters();
  const frames: Frame[] = [];
  const coalescer = new FrameCoalescer((frame) => frames.push(frame));
  const service = new RunService(db, ledger, coalescer, mcp, () => {}, quiet, hooks, { codex: { start }, claude: { start }, opencode: { start } }, writers);
  const conversations = new ThreadService(
    db,
    service,
    new WorkspaceService(db, { dataDir: root }, quiet, writers),
    () => {},
    quiet,
    async () => null,
    writers,
  );
  const input = { scope: { task: null, thread: parent }, project, ...settings, prompt: "Delegate", resume: false };
  const host = await service.start(input);
  const emit = (event: AgentEvent) => handles.get(host.id)!.emit("event", event);
  const events = (runId: string) => {
    ledger.flush();
    return listEvents(db, runId);
  };
  const launch = (id: string, extra: Partial<Extract<AgentEvent, { type: "subagent.started" }>> = {}) => {
    emit({ type: "subagent.started", runId: host.id, ts: Date.now(), subagentId: id, toolCallId: id, title: `Explore ${id}`, prompt: `Investigate ${id}`, agentType: "Explore", ...extra });
    return subagents.byNative(db, parent.id, id)!;
  };
  const update = (id: string, status: "running" | "completed" | "stopped" | "failed" | "no_updates", extra: Partial<Extract<AgentEvent, { type: "subagent.updated" }>> = {}) =>
    emit({ type: "subagent.updated", runId: host.id, ts: Date.now(), subagentId: id, status, ...extra });
  return { root, db, ledger, service, conversations, host, parent, project, handles, hooks, start, stop, send, frames, coalescer, input, emit, events, launch, update };
}

beforeEach(async () => {
  fixture = await setup();
});

it("serves bounded child pages with counts and keeps older native work and ordinary approvals", async () => {
  const { db, launch, update, parent, project, conversations, service, input } = fixture;
  const children = Array.from({ length: 20 }, (_, index) => {
    const child = launch(`page-${index}`);
    db.stmt("UPDATE threads SET created_at = ? WHERE id = ?").run(index + 1, child.threadId);
    if (index !== 0) update(`page-${index}`, "completed");
    return child;
  });
  const ordinary = threads.insert(db, { projectId: project.id, title: "Waiting older child", ...settings });
  threads.update(db, ordinary.id, { parentThreadId: parent.id, parentRelation: "started" });
  db.stmt("UPDATE threads SET created_at = 0 WHERE id = ?").run(ordinary.id);
  const run = await service.start({ ...input, scope: { task: null, thread: ordinary } });
  const approval = service.requestApproval(run.id, "choice", "AskUserQuestion", {});
  const page = conversations.list({ projectId: project.id, includeChildren: true });
  expect(page.map((thread) => thread.id)).toEqual(expect.arrayContaining([parent.id, children[0]!.threadId, ordinary.id]));
  // The ordinary child leads the page as a conversation you can talk to, ahead of newer subagents.
  expect(page).toHaveLength(7);
  expect(page.find((thread) => thread.id === parent.id)).toMatchObject({ hiddenChildren: 15 });
  expect(page.find((thread) => thread.id === ordinary.id)?.activity).toBe("waiting");
  expect(conversations.list({ projectId: project.id, includeChildren: true, childLimits: { [parent.id]: 17 } })).toHaveLength(19);
  const selected = conversations.list({ projectId: project.id, includeChildren: true, selectedId: children[1]!.threadId });
  expect(selected.some((thread) => thread.id === children[1]!.threadId)).toBe(true);
  await service.closeAndWait(run.id);
  await approval;
});
afterEach(async () => {
  await fixture.service.closeAll();
  fixture.coalescer.flush();
  fixture.coalescer.flush();
  fixture.ledger.close();
  fixture.db.close();
  await rm(fixture.root, { recursive: true, force: true });
});

it("creates one child and one hosted run for repeated starts, with its prompt and a linked parent event", () => {
  const { launch, host, parent, db, events, conversations, coalescer, frames } = fixture;
  const child = launch("a");
  expect(launch("a").threadId).toBe(child.threadId);
  expect(threads.children(db, parent.id)).toHaveLength(1);
  expect(runs.listForThread(db, child.threadId)).toHaveLength(1);
  expect(threads.get(db, child.threadId)).toMatchObject({ parentThreadId: parent.id, parentRelation: "subagent", title: "Explore a", agent: "codex" });
  expect(events(child.runId).map((event) => event.type)).toEqual(["message.completed", "turn.started"]);
  expect(events(child.runId)[0]).toMatchObject({ role: "user", text: "Investigate a" });
  expect(events(host.id)).toContainEqual(expect.objectContaining({ type: "subagent.started", threadId: child.threadId }));
  expect(conversations.get(child.threadId)).toMatchObject({ activity: "running", liveRunId: child.runId, subagent: { status: "running", stoppable: true } });
  coalescer.flush();
  expect(frames.some((frame) => frame.runId === child.runId)).toBe(true);
});

it("persists a recorded Codex stream into separate hosted runs", async () => {
  const { host, emit, db, parent, events } = fixture;
  const adapter = new CodexSubagents({ runId: host.id, root: () => "root", emit, request: async () => ({}) });
  for (const event of codexFixture.notifications) {
    adapter.route(event.method, event.params);
  }
  expect(threads.children(db, parent.id)).toHaveLength(2);
  const first = subagents.byNative(db, parent.id, "thread-5")!;
  const second = subagents.byNative(db, parent.id, "thread-8")!;
  expect(first.status).toBe("stopped");
  expect(second).toMatchObject({ status: "completed", result: "beta" });
  expect(events(second.runId)).toContainEqual(expect.objectContaining({ type: "message.completed", text: "beta" }));
  expect(
    events(host.id).some(
      (event) => event.type === "tool.started" || (event.type === "message.completed" && event.role !== "user") || event.type === "usage.updated" || event.type === "turn.completed",
    ),
  ).toBe(false);
  expect(runs.get(db, host.id)?.state).toBe("starting");
  adapter.close();
});

it("deletes finished children without acquiring or cleaning their parent's workspace", async () => {
  const { launch, update, db, conversations, parent, service } = fixture;
  const child = launch("delete");
  await expect(conversations.delete(child.threadId)).rejects.toThrow(/running/i);
  update("delete", "completed");
  await conversations.delete(child.threadId);
  expect(threads.get(db, child.threadId)).toBeNull();
  expect(threads.get(db, parent.id)).not.toBeNull();
  expect(service.liveRunForThread(parent.id)).not.toBeNull();
});

it("cleans only empty phantom children on startup, idempotently", () => {
  const { launch, db, ledger, service, emit, host, events } = fixture;
  const phantom = (id: string) => launch(id, { toolCallId: undefined, agentType: undefined, prompt: undefined });
  const empty = phantom("empty");
  const heartbeat = phantom("heartbeat");
  emit({ type: "subagent.updated", runId: host.id, ts: 2, subagentId: "heartbeat", progress: "x".repeat(10000) });
  emit({ type: "tool.updated", runId: host.id, ts: 2, subagentId: "heartbeat", toolCallId: "heartbeat", progress: "Running for 14s" });
  const content = phantom("content");
  emit({ type: "message.completed", runId: host.id, ts: 2, subagentId: "content", messageId: "answer", role: "assistant", text: "Keep me" });
  const real = launch("real");
  const update = phantom("update");
  emit({ type: "tool.updated", runId: host.id, ts: 2, subagentId: "update", toolCallId: "read", progress: "Reading a file" });
  ledger.flush();
  service.subagents.recoverInterrupted();
  ledger.flush();
  service.subagents.recoverInterrupted();
  expect([empty, heartbeat].map((row) => threads.get(db, row.threadId))).toEqual([null, null]);
  expect([content, real, update].every((row) => threads.get(db, row.threadId))).toBe(true);
  expect(events(host.id).filter((event) => (event.type === "subagent.started" || event.type === "subagent.updated") && [empty.threadId, heartbeat.threadId].includes(event.threadId ?? ""))).toEqual(
    [],
  );
  expect(events(host.id)).toContainEqual(expect.objectContaining({ type: "subagent.started", threadId: real.threadId }));
});

it("pages whole thread trees and includes the selected child's parent outside the page", () => {
  const { launch, db, parent, project } = fixture;
  const child = launch("a");
  const nested = launch("b", { parentSubagentId: "a" });
  const other = threads.insert(db, { projectId: project.id, title: "Other", ...settings });
  db.stmt("UPDATE threads SET last_activity_at = ? WHERE id = ?").run(Date.now() + 100, nested.threadId);
  const page = threads.list(db, { projectId: project.id, includeChildren: true, orderBy: "activity", limit: 1 });
  expect(page.map((row) => row.id).sort()).toEqual([parent.id, child.threadId, nested.threadId].sort());
  db.stmt("UPDATE threads SET last_activity_at = ? WHERE id = ?").run(Date.now() + 200, other.id);
  expect(threads.list(db, { projectId: project.id, includeChildren: true, orderBy: "activity", limit: 1, selectedId: nested.threadId })).toHaveLength(4);
});

it("persists workflow nesting, phase cards and full disk content without changing the host's usage", () => {
  const { host, emit, db, parent, events } = fixture;
  const parser = new ClaudeStreamParser(host.id);
  for (const line of [
    { type: "system", subtype: "task_started", task_type: "local_workflow", tool_use_id: "workflow", task_id: "task", workflow_name: "Inspect queue" },
    { type: "system", subtype: "task_progress", task_id: "task", workflow_progress: workflowFixture.progress },
  ])
    for (const event of parser.parseLine(JSON.stringify(line))) emit(event);
  for (const line of workflowFixture.transcript) for (const event of parser.workflowMessage("agent-1", line, Date.now())) emit(event);
  const workflow = subagents.byNative(db, parent.id, "workflow")!;
  const agent = subagents.byNative(db, parent.id, "workflow:1")!;
  expect(threads.children(db, parent.id).map((thread) => thread.id)).toEqual([workflow.threadId]);
  expect(threads.children(db, workflow.threadId)).toHaveLength(3);
  expect(events(workflow.runId)).toContainEqual(expect.objectContaining({ type: "subagent.started", group: "Inspect", threadId: agent.threadId }));
  expect(events(agent.runId)).toContainEqual(expect.objectContaining({ type: "tool.started", name: "Read" }));
  expect(runs.get(db, agent.runId)?.resultText).toBe("The complete result: the queue waits one frame before reading.");
  expect(events(host.id).some((event) => event.type === "usage.updated")).toBe(false);
  expect(events(host.id).some((event) => event.type === "message.completed" && event.role === "assistant")).toBe(false);
});

it("routes content before start and later fills in its prompt, model and nested parent", () => {
  const { emit, host, parent, db, launch, events } = fixture;
  emit({ type: "message.completed", runId: host.id, ts: Date.now(), subagentId: "nested", messageId: "answer", role: "assistant", text: "Already working" });
  const early = subagents.byNative(db, parent.id, "nested")!;
  const owner = launch("owner");
  const child = launch("nested", { parentSubagentId: "owner", model: "child-model", effort: "low" });
  expect(child.threadId).toBe(early.threadId);
  expect(threads.get(db, child.threadId)).toMatchObject({ parentThreadId: owner.threadId, model: "child-model", effort: "low" });
  expect(events(child.runId)).toContainEqual(expect.objectContaining({ text: "Already working" }));
  expect(events(child.runId).every((event) => event.subagentId === undefined)).toBe(true);
  expect(events(host.id).some((event) => event.type === "message.completed" && event.text === "Already working")).toBe(false);
  expect(events(owner.runId)).toContainEqual(expect.objectContaining({ type: "subagent.started", threadId: child.threadId }));
  expect(events(host.id).some((event) => event.type === "subagent.started" && event.threadId === child.threadId)).toBe(false);
  expect(
    events(child.runId)
      .filter((event) => event.type === "message.completed" && event.role === "user")
      .at(-1),
  ).toMatchObject({ text: "Investigate nested" });
});

it("keeps child usage, errors and completion out of the parent's context and turn", async () => {
  const { launch, emit, host, service, parent, events, db, hooks } = fixture;
  const child = launch("a");
  emit({ type: "usage.updated", runId: host.id, ts: Date.now(), usage: { inputTokens: 10, outputTokens: 5, contextTokens: 15 } });
  emit({ type: "usage.updated", runId: host.id, ts: Date.now(), subagentId: "a", usage: { inputTokens: 900, outputTokens: 50, contextTokens: 950, costUsd: 9 } });
  emit({ type: "error", runId: host.id, ts: Date.now(), subagentId: "a", message: "Child error", fatal: true });
  emit({ type: "turn.completed", runId: host.id, ts: Date.now(), subagentId: "a", turnId: "child-turn", status: "success", durationMs: 10, resultText: "Done" });
  await new Promise((resolve) => setImmediate(resolve));
  expect(service.threadContext(parent.id)?.used).toBe(15);
  expect(service.threadContext(child.threadId)?.used).toBe(950);
  expect(runs.get(db, child.runId)?.usage?.costUsd).toBeUndefined();
  expect(service.isBusy(host.id)).toBe(true);
  expect(hooks.onTurnSettled).not.toHaveBeenCalled();
  expect(events(host.id).filter((event) => event.type === "usage.updated")).toHaveLength(1);
  expect(runs.get(db, host.id)?.error).toBeNull();
  expect(runs.get(db, child.runId)).toMatchObject({ state: "success", resultText: "Done" });
});

it("settles once with the result and supports reopening the same child", () => {
  const { launch, update, events, db } = fixture;
  const child = launch("a");
  update("a", "completed", { result: "Findings" });
  update("a", "completed", { result: "Findings" });
  expect(events(child.runId).filter((event) => event.type === "turn.completed")).toHaveLength(1);
  expect(runs.get(db, child.runId)).toMatchObject({ state: "success", resultText: "Findings" });
  launch("a");
  expect(subagents.byThread(db, child.threadId)?.status).toBe("completed");
  update("a", "running");
  expect(runs.get(db, child.runId)).toMatchObject({ state: "running", endedAt: null });
  expect(events(child.runId).filter((event) => event.type === "turn.started")).toHaveLength(2);
});

it("rolls back the child status if settling its hosted run fails", () => {
  const { launch, db, host, parent, service } = fixture;
  const child = launch("atomic");
  const update = runs.update;
  const spy = vi.spyOn(runs, "update").mockImplementation((database, id, patch) => {
    if (id === child.runId && patch.state === "success") throw new Error("Injected write failure");
    return update(database, id, patch);
  });
  try {
    expect(() => service.subagents.route({ run: host, thread: parent }, { type: "subagent.updated", runId: host.id, subagentId: "atomic", ts: Date.now(), status: "completed" })).toThrow(
      "Injected write failure",
    );
    expect(subagents.byThread(db, child.threadId)?.status).toBe("running");
    expect(runs.get(db, child.runId)?.state).toBe("running");
  } finally {
    spy.mockRestore();
  }
});

it.each([true, false])("routes task subagents by the execution thread and drops unowned content (execution=%s)", async (attached) => {
  const { db, parent, project, service, input, handles, events } = fixture;
  const execution = threads.insert(db, { projectId: project.id, title: "Execution", ...settings });
  const created = tasks.insert(db, {
    projectId: project.id,
    threadId: attached ? parent.id : null,
    title: "Task",
    spec: "Inspect",
    priority: "none",
    labels: [],
    workspaceMode: "current",
    baseRef: null,
    parentTaskId: null,
  });
  const task = tasks.update(db, created.id, { executionThreadId: attached ? execution.id : null })!;
  const host = await service.start({ ...input, scope: { task, thread: null } });
  const emit = (event: AgentEvent) => handles.get(host.id)!.emit("event", event);
  emit({ type: "subagent.started", runId: host.id, ts: Date.now(), subagentId: "task-child", title: "Task child" });
  emit({ type: "usage.updated", runId: host.id, ts: Date.now(), subagentId: "task-child", usage: { inputTokens: 900, outputTokens: 50 } });
  emit({ type: "error", runId: host.id, ts: Date.now(), subagentId: "task-child", message: "Child failure", fatal: true });
  await new Promise((resolve) => setImmediate(resolve));
  expect(threads.children(db, execution.id)).toHaveLength(attached ? 1 : 0);
  expect(threads.children(db, parent.id)).toHaveLength(0);
  expect(events(host.id).some((e) => (e.subagentId && !e.type.startsWith("subagent.")) || e.type === "usage.updated" || e.type === "error")).toBe(false);
  expect(runs.get(db, host.id)?.error).toBeNull();
});

it("re-adopts a native child after a host restart and ignores frames from its old host", async () => {
  const { launch, update, service, host, parent, input, db, handles, events } = fixture;
  const child = launch("persistent");
  update("persistent", "completed", { result: "First answer" });
  await service.closeAndWait(host.id);
  const resumed = await service.start({ ...input, resume: true });
  const send = (event: AgentEvent) => handles.get(resumed.id)!.emit("event", event);
  send({ type: "subagent.started", runId: resumed.id, ts: Date.now(), subagentId: "persistent", title: "Resumed" });
  send({ type: "turn.started", runId: resumed.id, ts: Date.now(), subagentId: "persistent", turnId: "second" });
  send({ type: "turn.started", runId: resumed.id, ts: Date.now(), subagentId: "persistent", turnId: "second" });
  expect(threads.children(db, parent.id).map((t) => t.id)).toEqual([child.threadId]);
  expect(subagents.byThread(db, child.threadId)).toMatchObject({ hostRunId: resumed.id, status: "running", result: null });
  expect(runs.get(db, child.runId)).toMatchObject({ state: "running", resultText: null, endedAt: null });
  expect(events(child.runId).filter((e) => e.type === "turn.started")).toHaveLength(2);
  service.subagents.route({ run: host, thread: parent }, { type: "subagent.updated", runId: host.id, ts: Date.now(), subagentId: "persistent", status: "failed" });
  expect(subagents.byThread(db, child.threadId)).toMatchObject({ hostRunId: resumed.id, status: "running" });
});

it("keeps the parent working after its turn ends, and idles it when the last child ends", async () => {
  const { launch, emit, host, service, parent, hooks, update } = fixture;
  launch("a");
  launch("b");
  emit({ type: "turn.completed", runId: host.id, ts: Date.now(), turnId: "root", status: "success", durationMs: 1 });
  await vi.waitFor(() => expect(hooks.onTurnSettled).toHaveBeenCalledOnce());
  expect(service.threadActivity(parent.id)).toBe("running");
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(service.isLive(host.id)).toBe(true);
  expect(service.prepareForUpdate()).toBe(false);
  update("a", "completed");
  expect(service.threadActivity(parent.id)).toBe("running");
  update("b", "stopped");
  expect(service.threadActivity(parent.id)).toBe("idle");
  expect(hooks.onThreadIdle).toHaveBeenCalledWith(expect.objectContaining({ id: parent.id }));
});

it("parent Stop interrupts all running children even when its own turn has already ended", async () => {
  const { launch, update, emit, host, service, stop } = fixture;
  launch("a");
  launch("b");
  launch("finished");
  update("finished", "completed");
  emit({ type: "turn.completed", runId: host.id, ts: Date.now(), turnId: "parent", status: "success", durationMs: 1 });
  await service.interrupt(host.id);
  expect(stop.mock.calls).toEqual([
    ["a", "parent-stop"],
    ["b", "parent-stop"],
  ]);
});

it("leaves no result on a stopped child even after commentary and a descriptive stop summary", () => {
  const { launch, emit, host, update, db, events } = fixture;
  const child = launch("stop");
  emit({ type: "message.completed", runId: host.id, subagentId: "stop", ts: Date.now(), messageId: "commentary", role: "assistant", text: "Working" });
  update("stop", "stopped", { result: "Inspect the source" });
  expect(subagents.byThread(db, child.threadId)?.result).toBeNull();
  expect(runs.get(db, child.runId)?.resultText).toBeNull();
  expect(events(child.runId).find((e) => e.type === "turn.completed")).toMatchObject({ status: "cancelled" });
  expect(events(child.runId).find((e) => e.type === "turn.completed")).not.toHaveProperty("resultText");
});

it("keeps child approvals pending after a parent turn ends and denies only the child that ends", async () => {
  const { db, host, launch } = fixture;
  launch("a");
  launch("b");
  const approvals = new RunApprovals({ db, live: new Map(), isClosing: () => false, emit() {}, invalidate() {}, keysFor: () => [], log: quiet });
  const request = (id: string, subagentId?: string) =>
    approvals.handleCodexApproval({ runId: host.id, approvalId: id, kind: "user_input", params: { threadId: subagentId ?? "root" }, onceOnly: false, subagentId });
  const parent = request("parent");
  const child = request("child", "a");
  const sibling = request("sibling", "b");
  approvals.denyApprovals(host.id, null);
  await expect(parent).resolves.toMatchObject({ decision: "deny" });
  expect(approvals.pending().map((p) => p.approvalId)).toEqual(["child", "sibling"]);
  approvals.denyApprovals(host.id, "a");
  await expect(child).resolves.toMatchObject({ decision: "deny" });
  expect(approvals.pending().map((p) => p.approvalId)).toEqual(["sibling"]);
  approvals.denyApprovals(host.id);
  await sibling;
});

it("routes a native child approval through the live parent turn boundary", async () => {
  const { launch, update, host, service, emit, hooks } = fixture;
  launch("a");
  const response = service["codex"]["options"].onApproval({
    runId: host.id,
    approvalId: "child-question",
    subagentId: "a",
    kind: "user_input",
    onceOnly: true,
    params: { questions: [{ id: "q", header: "Choice", question: "Which option?", options: [{ label: "A", description: "First" }] }] },
  });
  expect(service.pending().map((p) => p.approvalId)).toContain("child-question");
  emit({ type: "turn.completed", runId: host.id, ts: Date.now(), turnId: "root", status: "success", durationMs: 1 });
  await vi.waitFor(() => expect(hooks.onTurnSettled).toHaveBeenCalled());
  expect(service.pending().map((p) => p.approvalId)).toContain("child-question");
  update("a", "completed");
  await expect(response).resolves.toMatchObject({ decision: "deny" });
  expect(service.pending()).toEqual([]);
});

it("stops only the selected child through its host and refuses sending or changing a hosted run", async () => {
  const { launch, service, stop, send, conversations, input, db } = fixture;
  const child = launch("a");
  launch("b");
  await service.subagents.stop(child.threadId);
  expect(stop).toHaveBeenCalledExactlyOnceWith("a");
  expect(send).not.toHaveBeenCalled();
  await expect(service.send(child.runId, "More")).rejects.toThrow(/read-only/);
  expect(() => service.steer(child.runId, "More")).toThrow(/read-only/);
  expect(() => service.compact(child.runId)).toThrow(/read-only/);
  await expect(service.interrupt(child.runId)).rejects.toThrow(/read-only/);
  expect(() => service.close(child.runId)).toThrow(/read-only/);
  await expect(service.closeAndWait(child.runId)).rejects.toThrow(/read-only/);
  await expect(service.start({ ...input, scope: { task: null, thread: threads.get(db, child.threadId)! } })).rejects.toThrow(/read-only/);
  expect(() => conversations.queue(child.threadId, "More")).toThrow(/read-only/);
  expect(() => conversations.update(child.threadId, { pinned: true })).toThrow(/read-only/);
  expect(() => conversations.update(child.threadId, { seen: true })).not.toThrow();
  await expect(conversations.delete(child.threadId)).rejects.toThrow(/running/);
});

it("settles every running child on host exit and preserves already completed results", async () => {
  const { launch, update, service, host, db, events } = fixture;
  const finished = launch("a");
  update("a", "completed", { result: "Kept" });
  const child = launch("b");
  const nested = launch("c", { parentSubagentId: "b" });
  await service.closeAndWait(host.id);
  for (const row of [child, nested]) {
    expect(subagents.byThread(db, row.threadId)?.status).toBe("stopped");
    expect(events(row.runId).filter((event) => event.type === "turn.completed")).toHaveLength(1);
  }
  expect(subagents.byThread(db, finished.threadId)).toMatchObject({ status: "completed", result: "Kept" });
  expect(service.subagents.summary(child.threadId)?.stoppable).toBe(false);
});

it("sweeps unfinished children on restart without marking their threads as broken sessions", () => {
  const { launch, service, db, events } = fixture;
  const child = launch("a");
  service.recoverInterrupted();
  service.recoverInterrupted();
  expect(subagents.byThread(db, child.threadId)?.status).toBe("stopped");
  expect(service.threadSession(child.threadId)).toEqual({ status: "idle", message: null });
  expect(events(child.runId).filter((event) => event.type === "turn.completed")).toHaveLength(1);
});

it("deletes the subagent tree with the parent but keeps independent started threads", async () => {
  const { launch, conversations, parent, db, project } = fixture;
  const child = launch("a");
  const nested = launch("b", { parentSubagentId: "a" });
  const independent = threads.insert(db, { projectId: project.id, title: "Started", ...settings });
  threads.update(db, independent.id, { parentThreadId: parent.id });
  expect(threads.get(db, independent.id)?.parentRelation).toBe("started");
  await conversations.delete(parent.id);
  expect(threads.get(db, child.threadId)).toBeNull();
  expect(threads.get(db, nested.threadId)).toBeNull();
  expect(runs.get(db, child.runId)).toBeNull();
  expect(threads.get(db, independent.id)?.parentThreadId).toBeNull();
  expect(db.stmt("PRAGMA foreign_key_check").all()).toEqual([]);
});

it.each(["failed", "stopped"] as const)("Codex re-adoption preserves a %s child's result and turn history", async (status) => {
  const { launch, update, service, input, host, handles, db, events } = fixture;
  const child = launch("persistent");
  update("persistent", status, { result: "Boom" });
  const before = runs.get(db, child.runId);
  const completions = events(child.runId).filter((e) => e.type === "turn.completed");
  await service.closeAndWait(host.id);
  const resumed = await service.start({ ...input, resume: true });
  const adapter = new CodexSubagents({ runId: resumed.id, root: () => "root", emit: (event) => handles.get(resumed.id)!.emit("event", event), request: async () => ({}) });
  adapter.route("item/started", { threadId: "root", item: { type: "collabAgentToolCall", tool: "sendInput", receiverThreadIds: ["persistent"] } });
  expect(subagents.byThread(db, child.threadId)).toMatchObject({ status, hostRunId: resumed.id });
  expect(runs.get(db, child.runId)).toMatchObject({ state: before!.state, resultText: before!.resultText });
  expect(events(child.runId).filter((e) => e.type === "turn.completed")).toEqual(completions);
});

it("parent Stop survives a child's interrupt error and settles children without a native turn", async () => {
  const { launch, service, host, handles, stop, db } = fixture;
  const broken = launch("broken");
  const turnless = launch("turnless");
  launch("sibling");
  const handle = handles.get(host.id)!;
  const parentStop = vi.spyOn(handle, "interrupt").mockResolvedValue();
  vi.spyOn(handle, "canStopSubagent").mockImplementation((id) => id !== "turnless");
  stop.mockImplementation(async (id) => {
    if (id === "broken") throw new Error("Transport gone");
  });
  await expect(service.interrupt(host.id)).resolves.toBeUndefined();
  expect(parentStop).toHaveBeenCalledOnce();
  expect(stop.mock.calls.map(([id]) => id)).toEqual(["broken", "sibling"]);
  expect(subagents.byThread(db, turnless.threadId)?.status).toBe("stopped");
  expect(subagents.byThread(db, broken.threadId)).toMatchObject({ status: "failed", result: "Could not stop: Transport gone" });
});

it("parent Stop settles a child its agent can't stop, so a thread that hit its usage limit takes the next message", async () => {
  const { emit, host, service, parent, handles, hooks, start } = fixture;
  emit({ type: "message.completed", runId: host.id, ts: Date.now(), subagentId: "unannounced", messageId: "child-text", role: "assistant", text: "Working" });
  vi.spyOn(handles.get(host.id)!, "canStopSubagent").mockReturnValue(false);
  emit({ type: "turn.completed", runId: host.id, ts: Date.now(), turnId: "root", status: "error", resultText: "You've hit your 5-hour limit", durationMs: 1 });
  await vi.waitFor(() => expect(hooks.onTurnSettled).toHaveBeenCalledOnce());
  await service.interrupt(host.id);
  expect(service.threadActivity(parent.id)).toBe("idle");
  await service.send(host.id, "Carry on");
  expect(start).toHaveBeenCalledTimes(2);
});

it("a forked skill's agent ends with its skill, so a thread that hit its usage limit takes the next message", async () => {
  const { emit, host, service, parent, hooks, start, db } = fixture;
  const parser = new ClaudeStreamParser(host.id);
  for (const line of forkedSkill) for (const event of parser.parseLine(JSON.stringify(line))) emit(event);
  emit({ type: "turn.completed", runId: host.id, ts: Date.now(), turnId: "root", status: "error", resultText: "You've hit your 5-hour limit", durationMs: 1 });
  await vi.waitFor(() => expect(hooks.onTurnSettled).toHaveBeenCalledOnce());
  expect(subagents.byNative(db, parent.id, "skill-1")).toMatchObject({ status: "completed", taskId: "task-1" });
  expect(threads.get(db, subagents.byNative(db, parent.id, "skill-1")!.threadId)?.title).toBe("/list-files");
  expect(service.threadActivity(parent.id)).toBe("idle");
  await service.send(host.id, "Carry on");
  expect(start).toHaveBeenCalledTimes(2);
});

it("startup recovery preserves the parent's and child's activity order", () => {
  const { launch, service, db, parent } = fixture;
  const child = launch("interrupted");
  const beforeParent = threads.get(db, parent.id)!.lastActivityAt;
  const beforeChild = threads.get(db, child.threadId)!.lastActivityAt;
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
  service.subagents.recoverInterrupted();
  expect(subagents.byThread(db, child.threadId)?.status).toBe("stopped");
  expect(threads.get(db, parent.id)!.lastActivityAt).toBe(beforeParent);
  expect(threads.get(db, child.threadId)!.lastActivityAt).toBe(beforeChild);
  vi.restoreAllMocks();
});

it.each([true, false])("scopes Claude MCP approval ids even when the stream arrives first=%s", async (streamFirst) => {
  const { launch, service, emit, host, update } = fixture;
  launch("claude-child");
  const tool = () =>
    emit({ type: "tool.started", runId: host.id, subagentId: "claude-child", ts: Date.now(), toolCallId: "child-question", name: "AskUserQuestion", input: {}, parentToolCallId: null });
  if (streamFirst) tool();
  const childApproval = service.requestApproval(host.id, "child-question", "AskUserQuestion", { questions: [{ question: "Which file?" }] });
  if (!streamFirst) tool();
  const parentApproval = service.requestApproval(host.id, "parent-question", "AskUserQuestion", {});
  emit({ type: "turn.completed", runId: host.id, ts: Date.now(), turnId: "parent", status: "success", durationMs: 1 });
  await expect(parentApproval).resolves.toMatchObject({ decision: "deny" });
  expect(service.pending()).toMatchObject([{ approvalId: "child-question", subagentId: "claude-child" }]);
  update("claude-child", "stopped");
  await expect(childApproval).resolves.toMatchObject({ decision: "deny" });
});

it("keeps Claude resume aliases small without rewriting stored prompts or carrying workflows", async () => {
  const { service, input, host, parent, db, start } = fixture;
  await service.closeAndWait(host.id);
  const claude = await service.start({ ...input, agent: "claude", resume: false });
  const prompt = "Long assignment ".repeat(5000);
  for (const [id, agentType] of [
    ["agent", "Explore"],
    ["workflow", "workflow"],
  ]) {
    service.subagents.route({ run: claude, thread: parent }, { type: "subagent.started", runId: claude.id, ts: Date.now(), subagentId: id!, title: id!, agentType, prompt });
    service.subagents.route({ run: claude, thread: parent }, { type: "subagent.updated", runId: claude.id, ts: Date.now(), subagentId: id!, taskId: `task-${id}`, status: "completed" });
  }
  runs.update(db, claude.id, { externalSessionId: "claude-session" });
  await service.closeAndWait(claude.id);
  await service.start({ ...input, agent: "claude", resume: true });
  const aliases = start.mock.lastCall![0].resumedSubagents;
  expect(aliases).toMatchObject([{ nativeId: "agent", taskId: "task-agent" }]);
  expect(aliases).toHaveLength(1);
  expect(JSON.stringify(aliases).length).toBeLessThan(500);
  expect(subagents.byNative(db, parent.id, "agent")?.prompt).toBe(prompt);
});

it("settles a child with missing updates without recording a failed run or a turn error", () => {
  const { launch, update, db, events, service } = fixture;
  const child = launch("legacy");
  update("legacy", "no_updates");
  expect(subagents.byThread(db, child.threadId)?.status).toBe("no_updates");
  expect(service.threadSession(child.threadId)).toEqual({ status: "idle", message: null });
  expect(runs.get(db, child.runId)).toMatchObject({ state: "cancelled", error: null });
  expect(events(child.runId).filter((e) => e.type === "turn.completed")).toEqual([expect.objectContaining({ status: "cancelled", observationEnded: true })]);
});
