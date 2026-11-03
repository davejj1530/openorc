import { expect, it, vi } from "vitest";
import type { AgentEvent } from "@openorc/protocol";
import { CodexSubagents } from "./subagents.js";
import fixture from "./test-fixtures/subagents.json";

function setup() {
  const events: AgentEvent[] = [];
  const request = vi.fn(async (method: string, params: unknown): Promise<unknown> => {
    const id = params && typeof params === "object" && "threadId" in params ? params.threadId : undefined;
    return fixture.reads.find((read) => read.method === method && read.threadId === id)?.result ?? {};
  });
  const children = new CodexSubagents({ runId: "host", root: () => "root", emit: (event) => events.push(event), request });
  const notify = (method: string, params: unknown) => {
    children.route(method, params);
  };
  const spawn = (id: string, owner = "root") =>
    notify("item/started", { threadId: owner, item: { id: `launch-${id}`, type: "subAgentActivity", kind: "started", agentThreadId: id, agentPath: `/root/${id}` } });
  return { children, events, request, notify, spawn };
}

it("replays the real two-child stream with isolated content, nicknames and terminal states", async () => {
  const { notify, events, children } = setup();
  for (const event of fixture.notifications) notify(event.method, event.params);
  await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "subagent.started", title: "Descartes" })));
  const starts = events.filter((event) => event.type === "subagent.started");
  expect(new Set(starts.map((event) => event.subagentId))).toEqual(new Set(["thread-5", "thread-8"]));
  expect(events).toContainEqual(expect.objectContaining({ type: "message.completed", subagentId: "thread-8", text: "beta" }));
  expect(events).toContainEqual(expect.objectContaining({ type: "subagent.updated", subagentId: "thread-5", status: "stopped" }));
  expect(events).toContainEqual(expect.objectContaining({ type: "subagent.updated", subagentId: "thread-8", status: "completed", result: "beta" }));
  expect(events.every((event) => event.subagentId && event.subagentId !== "root")).toBe(true);
  expect(events.some((event) => event.type === "turn.completed")).toBe(false);
  expect(children.canStop("thread-5")).toBe(false);
});

it("stops only the selected active child turn and keeps sibling state", async () => {
  const { children, spawn, notify, request } = setup();
  for (const id of ["a", "b"]) {
    spawn(id);
    notify("turn/started", { threadId: id, turn: { id: `turn-${id}` } });
  }
  await children.stop("a");
  expect(request).toHaveBeenCalledWith("turn/interrupt", { threadId: "a", turnId: "turn-a" });
  notify("turn/completed", { threadId: "a", turn: { id: "turn-a", status: "interrupted" } });
  expect(children.canStop("a")).toBe(false);
  expect(children.canStop("b")).toBe(true);
  children.close();
  expect(children.canStop("b")).toBe(false);
});

it("combines launch sources without losing lineage, prompt or nickname", () => {
  const { children, notify, spawn, events } = setup();
  spawn("owner");
  notify("thread/started", { thread: { id: "nested", agentNickname: "Checker", source: { subAgent: { thread_spawn: { parent_thread_id: "owner" } } } } });
  notify("item/completed", {
    threadId: "owner",
    item: { id: "spawn", type: "collabAgentToolCall", tool: "spawnAgent", receiverThreadIds: ["nested"], prompt: "Inspect this\nThen report", agentsStates: { nested: { status: "running" } } },
  });
  expect(events.filter((event) => event.type === "subagent.started").at(-1)).toMatchObject({
    subagentId: "nested",
    title: "Checker",
    parentSubagentId: "owner",
    prompt: "Inspect this\nThen report",
    toolCallId: "spawn",
  });
  expect(children.title({ threadId: "nested" })).toBe("Checker");
  notify("item/completed", { threadId: "owner", item: { type: "collabAgentToolCall", tool: "wait", agentsStates: { nested: { status: "errored", message: "Failed to inspect" } } } });
  expect(events).toContainEqual(expect.objectContaining({ type: "subagent.updated", status: "failed", result: "Failed to inspect" }));
  notify("item/started", { threadId: "owner", item: { type: "collabAgentToolCall", tool: "sendInput", receiverThreadIds: ["nested"] } });
  expect(events.filter((event) => event.type === "subagent.updated" && event.subagentId === "nested").at(-1)).toMatchObject({ status: "failed" });
});

it("buffers early child turns and content until spawn registration, then hydrates and enables Stop", async () => {
  const { notify, events, children, request } = setup();
  notify("item/started", { threadId: "root", item: { type: "collabAgentToolCall", tool: "spawnAgent", receiverThreadIds: [] } });
  notify("turn/started", { threadId: "early", turn: { id: "turn" } });
  notify("item/completed", { threadId: "early", item: { type: "agentMessage", id: "first", text: "First words" } });
  notify("item/completed", { threadId: "root", item: { type: "collabAgentToolCall", tool: "spawnAgent", receiverThreadIds: ["early"] } });
  expect(events).toContainEqual(expect.objectContaining({ type: "message.completed", subagentId: "early", text: "First words" }));
  expect(children.canStop("early")).toBe(true);
  expect(request).toHaveBeenCalledWith("thread/read", { threadId: "early", includeTurns: false });
});

it.each(["sendInput", "resumeAgent", "followupTask"])("re-adopts a persisted child through %s without inventing a turn", (tool) => {
  const { notify, events, children } = setup();
  notify("item/started", { threadId: "root", item: { type: "collabAgentToolCall", tool, receiverThreadIds: ["persisted"] } });
  expect(events).toContainEqual(expect.objectContaining({ type: "subagent.started", subagentId: "persisted" }));
  expect(events.some((e) => e.type === "subagent.updated")).toBe(false);
  notify("item/completed", { threadId: "root", item: { type: "collabAgentToolCall", tool, status: "failed", agentsStates: {} } });
  expect(children.canStop("persisted")).toBe(false);
  notify("turn/started", { threadId: "persisted", turn: { id: "resumed" } });
  expect(children.canStop("persisted")).toBe(true);
  expect(events.at(-1)).toMatchObject({ type: "subagent.updated", status: "running" });
});

it("keeps completion stable across closeAgent and stale pendingInit, but reopens on a new native turn", () => {
  const { notify, spawn, events } = setup();
  spawn("a");
  notify("turn/started", { threadId: "a", turn: { id: "one" } });
  notify("turn/completed", { threadId: "a", turn: { id: "one", status: "completed" } });
  const count = events.length;
  for (const status of ["shutdown", "pendingInit"]) notify("item/completed", { threadId: "root", item: { type: "collabAgentToolCall", tool: "closeAgent", agentsStates: { a: { status } } } });
  expect(events.slice(count).filter((e) => e.type === "subagent.updated")).toEqual([]);
  notify("turn/started", { threadId: "a", turn: { id: "two" } });
  notify("turn/completed", { threadId: "a", turn: { id: "one", status: "completed" } });
  expect(events.filter((e) => e.type === "subagent.updated").at(-1)).toMatchObject({ status: "running" });
});

it("ignores unrelated threads and keeps child reasoning buffers independent", () => {
  const { spawn, notify, events } = setup();
  notify("item/completed", { threadId: "unknown", item: { id: "hidden", type: "agentMessage", text: "Hidden" } });
  expect(events).toEqual([]);
  for (const id of ["a", "b"]) {
    spawn(id);
    notify("item/started", { threadId: id, item: { id: "same-id", type: "reasoning" } });
    notify("item/reasoning/summaryTextDelta", { threadId: id, itemId: "same-id", summaryIndex: 0, delta: id });
  }
  expect(events.filter((event) => event.type === "thinking.delta").map((event) => [event.subagentId, event.text])).toEqual([
    ["a", "a"],
    ["b", "b"],
  ]);
});

it("bounds early traffic without evicting the turn needed for Stop and hydration", () => {
  const { notify, spawn, events, children, request } = setup();
  notify("turn/started", { threadId: "early", turn: { id: "turn" } });
  for (let i = 0; i < 137; i++) notify("item/agentMessage/delta", { threadId: "early", itemId: "answer", delta: `${i},` });
  spawn("early");
  expect(children.canStop("early")).toBe(true);
  expect(request).toHaveBeenCalledWith("thread/read", { threadId: "early", includeTurns: false });
  expect(events.filter((e) => e.type === "message.delta")).toHaveLength(127);
  for (let i = 0; i < 33; i++) notify("turn/started", { threadId: `unknown-${i}`, turn: { id: `turn-${i}` } });
  spawn("unknown-0");
  spawn("unknown-1");
  expect(children.canStop("unknown-0")).toBe(false);
  expect(children.canStop("unknown-1")).toBe(true);
});

it("keeps a stopped turnless child stopped on a late first turn, then permits a follow-up's new turn", () => {
  const { children, spawn, notify, events } = setup();
  spawn("a");
  children.interrupt();
  notify("turn/started", { threadId: "a", turn: { id: "late" } });
  expect(children.canStop("a")).toBe(false);
  expect(events.filter((e) => e.type === "subagent.updated").at(-1)).toMatchObject({ status: "stopped" });
  notify("item/started", { threadId: "root", item: { type: "collabAgentToolCall", tool: "followupTask", receiverThreadIds: ["a"] } });
  notify("turn/started", { threadId: "a", turn: { id: "late" } });
  expect(children.canStop("a")).toBe(false);
  notify("turn/started", { threadId: "a", turn: { id: "resumed" } });
  expect(children.canStop("a")).toBe(true);
});
