import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentEvent } from "@openorc/protocol";
import { CodexAdapter, type RunHandle } from "@openorc/agents";
import { applyFrame, getRun, hydrate, resetTranscripts } from "./transcript";
import { Db, LedgerWriter, listEvents, projects, threads, runs } from "@openorc/db";
import { core } from "./rpc";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("./rpc", () => ({ core: { onFrame: vi.fn(), call: vi.fn() } }));
beforeEach(() => resetTranscripts());
const sessions = new Set<RunHandle>();
async function closeSession(handle: RunHandle): Promise<void> {
  handle.close();
  await handle.wait();
  sessions.delete(handle);
}
afterEach(async () => {
  await Promise.all([...sessions].map(closeSession));
});

/** Real adapter + stdio JSON-RPC + schema + renderer projection, with a controlled provider. */
async function server() {
  const stdin = new PassThrough(),
    stdout = new PassThrough(),
    stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: undefined,
    kill: () => {
      proc.emit("exit", 0);
      proc.emit("close", 0);
      return true;
    },
  });
  vi.mocked(spawn).mockReturnValue(proc as unknown as ChildProcess);
  const notify = (method: string, params: unknown) => stdout.write(JSON.stringify({ method, params }) + "\n");
  const requests: string[] = [];
  stdin.on("data", (data: Buffer) => {
    const req = JSON.parse(data.toString());
    if (!req.method || req.id === undefined) return;
    requests.push(req.method);
    queueMicrotask(() => {
      stdout.write(JSON.stringify({ id: req.id, result: req.method === "thread/start" ? { thread: { id: "thread" } } : {} }) + "\n");
      if (req.method === "turn/start") notify("turn/started", { turn: { id: "turn" } });
    });
  });
  const handle = new CodexAdapter({ onApproval: async () => "deny" }).start(
    { runId: "run", agent: "codex", cwd: process.cwd(), prompt: "Hello", permissionMode: "autonomous" },
    { revision: 0, binary: "codex", env: process.env },
  );
  sessions.add(handle);
  const ledger: AgentEvent[] = [];
  let seq = 0;
  handle.on("event", (event) => {
    const ev = AgentEvent.parse(event);
    ledger.push(ev);
    applyFrame({ runId: "run", seq: seq++, events: [ev] });
  });
  await vi.waitFor(() => expect(requests).toContain("turn/start"));
  const item = (phase: "started" | "completed", type: string, id: string, fields = {}) => notify(`item/${phase}`, { threadId: "thread", turnId: "turn", item: { type, id, ...fields } });
  const blocks = () => getRun("run")!.blocks;
  return { handle, close: () => closeSession(handle), notify, item, blocks, ledger, requests, proc };
}

it("shows reasoning at start, without summaries, and closes at its own completion", async () => {
  const s = await server();
  try {
    s.item("started", "reasoning", "think", { summary: [] });
    expect(s.blocks()).toContainEqual(expect.objectContaining({ kind: "thinking", text: "", endedAt: null }));
    s.notify("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 1, outputTokens: 0 } } });
    s.item("completed", "reasoning", "think", { summary: [] });
    expect(s.blocks().find((b) => b.kind === "thinking")).toMatchObject({ endedAt: expect.any(Number) });
  } finally {
    await s.close();
  }
});

it("streams summary paragraphs and reconciles final summaries without raw reasoning", async () => {
  const s = await server();
  try {
    s.item("started", "reasoning", "think");
    const start = s.blocks().find((b) => b.kind === "thinking");
    s.notify("item/reasoning/summaryTextDelta", { itemId: "think", summaryIndex: 0, delta: "First" });
    s.notify("item/reasoning/summaryTextDelta", { itemId: "think", summaryIndex: 1, delta: "Second" });
    s.notify("item/reasoning/textDelta", { itemId: "think", delta: "Private text" });
    s.item("started", "commandExecution", "parallel", { command: "pwd" });
    expect(s.blocks().find((b) => b.kind === "thinking")).toMatchObject({ text: "First\n\nSecond", endedAt: null });
    s.item("completed", "reasoning", "think", { summary: ["First", "Second complete"] });
    expect(s.blocks().find((b) => b.kind === "thinking")).toMatchObject({ text: "First\n\nSecond complete", startedAt: start?.kind === "thinking" ? start.startedAt : 0, endedAt: expect.any(Number) });
  } finally {
    await s.close();
  }
});

it.each([["webSearch", { query: "release notes", action: { type: "search", query: "release notes" }, results: [{ title: "Result" }] }]] as const)(
  "projects %s start and completion with inspectable provider details",
  async (type, fields) => {
    const s = await server();
    try {
      s.item("started", type, "step", fields);
      expect(s.blocks().find((b) => b.id === "activity-step")).toMatchObject({ kind: "activity", status: "running" });
      s.item("completed", type, "step", { ...fields, status: "completed" });
      const expected = Object.fromEntries(Object.entries(fields).filter(([key]) => key !== "result"));
      expect(s.blocks().find((b) => b.id === "activity-step")).toMatchObject({ status: "success", detail: expect.objectContaining(expected) });
    } finally {
      await s.close();
    }
  },
);

it("shows tool progress, changing patches, and final failures", async () => {
  const s = await server();
  try {
    s.item("started", "fileChange", "patch", { changes: [], status: "inProgress" });
    const changes = [{ path: "a.ts", kind: { type: "update" }, diff: "+new" }];
    s.notify("item/fileChange/patchUpdated", { itemId: "patch", changes });
    s.notify("item/fileChange/outputDelta", { itemId: "patch", delta: "Applying..." });
    expect(s.blocks().find((b) => b.id === "patch")).toMatchObject({ input: changes, output: "Applying...", done: false });
    s.item("completed", "fileChange", "patch", { changes, status: "failed" });
    expect(s.blocks().find((b) => b.id === "patch")).toMatchObject({ output: "Applying...", status: "error", done: true });
    for (const type of ["mcpToolCall", "dynamicToolCall"]) {
      s.item("started", type, type, { server: "test", tool: "lookup", arguments: { query: "q" } });
      s.notify("item/mcpToolCall/progress", { itemId: type, message: "Found 2 records" });
      expect(s.blocks().find((b) => b.id === type)).toMatchObject({ progress: "Found 2 records", done: false });
      s.item("completed", type, type, { server: "test", tool: "lookup", status: "failed", success: false, error: { message: "Unavailable" } });
      expect(s.blocks().find((b) => b.id === type)).toMatchObject({ isError: true, done: true });
    }
  } finally {
    await s.close();
  }
});

it("streams plans and replaces plan progress snapshots in place", async () => {
  const s = await server();
  try {
    s.item("started", "plan", "plan-item", { text: "" });
    s.notify("item/plan/delta", { itemId: "plan-item", delta: "Inspect" });
    expect(s.blocks().find((b) => b.id === "activity-plan-item")).toMatchObject({ text: "Inspect", status: "running" });
    s.item("completed", "plan", "plan-item", { text: "Inspect and test" });
    s.notify("turn/plan/updated", { turnId: "turn", plan: [{ step: "Inspect", status: "inProgress" }] });
    expect(s.blocks().find((b) => b.id === "activity-plan-turn")).toMatchObject({ status: "running", text: "inProgress: Inspect" });
    s.notify("turn/plan/updated", { turnId: "turn", plan: [{ step: "Inspect", status: "completed" }] });
    expect(s.blocks().filter((b) => b.id === "activity-plan-turn")).toHaveLength(1);
    expect(s.blocks().find((b) => b.id === "activity-plan-turn")).toMatchObject({ status: "success", text: "completed: Inspect" });
  } finally {
    await s.close();
  }
});

it.each(["failed", "fatal"])("closes all live indicators on %s", async (terminal) => {
  const s = await server();
  try {
    s.item("started", "reasoning", "thinking");
    s.item("started", "commandExecution", "command", { command: "sleep 10" });
    s.notify("item/agentMessage/delta", { itemId: "message", delta: "Working" });
    s.item("started", "contextCompaction", "compact");
    if (terminal === "exit") await s.close();
    else if (terminal === "fatal") s.proc.emit("error", new Error("Disconnected"));
    else s.notify("turn/completed", { turn: { id: "turn", status: terminal } });
    expect(
      s
        .blocks()
        .some((b) => (b.kind === "thinking" && b.endedAt === null) || (b.kind === "tool" && !b.done) || (b.kind === "activity" && b.status === "running") || (b.kind === "message" && b.streaming)),
    ).toBe(false);
  } finally {
    await s.close();
  }
});

it("shows hooks, automatic approval review, and connection recovery", async () => {
  const s = await server();
  try {
    s.notify("hook/started", { run: { id: "hook", eventName: "PreToolUse", status: "running" } });
    s.notify("item/autoApprovalReview/started", { reviewId: "approval", review: { status: "inProgress" } });
    s.notify("modelProvider/authRecoveryStarted", { turnId: "turn", provider: "test", message: "Reconnecting" });
    expect(s.blocks().filter((b) => b.kind === "activity" && b.status === "running")).toHaveLength(3);
    s.notify("hook/completed", { run: { id: "hook", eventName: "PreToolUse", status: "blocked", statusMessage: "Blocked by hook" } });
    s.notify("item/autoApprovalReview/completed", { reviewId: "approval", review: { status: "denied", rationale: "Not authorized" } });
    s.notify("modelProvider/authRecoveryCompleted", { turnId: "turn", provider: "test", message: "Connected" });
    expect(s.blocks().filter((b) => b.kind === "activity" && b.status === "running")).toHaveLength(0);
    expect(s.blocks().filter((b) => b.kind === "activity" && b.status === "error")).toHaveLength(2);
  } finally {
    await s.close();
  }
});

it("keeps normal assistant streaming and transcript order on reload and conversation switches", async () => {
  const s = await server();
  s.item("started", "reasoning", "think");
  s.item("completed", "reasoning", "think", { summary: [] });
  s.item("started", "commandExecution", "cmd", { command: "echo result" });
  s.notify("item/commandExecution/outputDelta", { itemId: "cmd", delta: "result" });
  s.item("completed", "commandExecution", "cmd", { aggregatedOutput: null, exitCode: 0 });
  s.notify("item/agentMessage/delta", { itemId: "reply", delta: "Hello" });
  expect(s.blocks().find((b) => b.id === "reply")).toMatchObject({ text: "Hello", streaming: true });
  s.item("completed", "agentMessage", "reply", { text: "Hello there" });
  await s.close();
  const before = structuredClone(s.blocks());
  applyFrame({ runId: "other", seq: 1, events: [{ type: "message.completed", runId: "other", ts: 1, messageId: "user", role: "user", text: "Other thread" }] });
  expect(s.blocks()).toEqual(before);
  resetTranscripts();
  const db = Db.memory();
  const project = projects.insert(db, { name: "Replay", rootPath: "/tmp/replay", gitRemote: null, defaultBranch: "main", settings: {} });
  const thread = threads.insert(db, { projectId: project.id, title: "Replay", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  runs.insert(db, { id: "run", threadId: thread.id, taskId: null, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  const writer = new LedgerWriter(db, { artifactThresholdBytes: 100 });
  try {
    for (const event of s.ledger) writer.push(event);
    writer.flush();
    const persisted = listEvents(db, "run");
    expect(persisted.every((event) => event.type !== "raw")).toBe(true);
    expect(writer.artifactsWritten).toBeGreaterThan(0);
    vi.mocked(core.call).mockResolvedValue({ events: persisted, fromTurn: 0, live: false });
    await hydrate("run");
    expect(s.blocks()).toEqual(before);
  } finally {
    writer.close();
    db.close();
  }
});

it("does not double append deltas delivered both in history and buffered live frames", async () => {
  const events: AgentEvent[] = [
    { type: "tool.started", eventId: "1", runId: "run", ts: 1, toolCallId: "cmd", name: "shell", input: {}, parentToolCallId: null },
    { type: "tool.output.delta", eventId: "2", runId: "run", ts: 2, toolCallId: "cmd", text: "same\n" },
  ];
  let resolve!: (page: { events: AgentEvent[]; fromTurn: number; live: boolean }) => void;
  vi.mocked(core.call).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = hydrate("run");
  applyFrame({ runId: "run", seq: 1, events: [events[1]!, { ...events[1]!, eventId: "3" }] });
  resolve({ events, fromTurn: 0, live: false });
  await pending;
  expect(getRun("run")?.blocks.find((b) => b.id === "cmd")).toMatchObject({ output: "same\nsame\n" });
});

it("preserves approval resolution and shows empty response starts, terminal input and turn diffs", async () => {
  const s = await server();
  try {
    s.item("started", "agentMessage", "reply", { text: "" });
    expect(s.blocks().find((b) => b.id === "reply")).toMatchObject({ kind: "message", streaming: true, text: "" });
    s.item("completed", "agentMessage", "reply", { text: "Done" });
    s.item("started", "commandExecution", "cmd", { command: "read" });
    s.notify("item/commandExecution/terminalInteraction", { itemId: "cmd", stdin: "yes" });
    expect(s.blocks().find((b) => b.id === "cmd")).toMatchObject({ progress: "Terminal input: yes" });
    s.notify("turn/diff/updated", { turnId: "turn", diff: "+added" });
    s.notify("turn/diff/updated", { turnId: "turn", diff: "+added\n+more" });
    expect(s.blocks().find((b) => b.id === "activity-diff-turn")).toMatchObject({ text: "+added\n+more" });
    applyFrame({ runId: "run", seq: 100, events: [{ type: "approval.requested", runId: "run", ts: 1, approvalId: "ask", kind: "command", input: {} }] });
    applyFrame({ runId: "run", seq: 101, events: [{ type: "approval.resolved", runId: "run", ts: 2, approvalId: "ask", decision: "deny" }] });
    expect(getRun("run")?.pendingApprovals).toBe(0);
    expect(s.blocks().find((b) => b.kind === "approval")).toMatchObject({ decision: "deny" });
  } finally {
    await s.close();
  }
});

it("shows automatic compaction throughout its lifecycle without duplicating it or blocking input on a late legacy completion notice", async () => {
  const s = await server();
  try {
    s.item("started", "contextCompaction", "compact");
    expect(s.blocks()).toContainEqual(expect.objectContaining({ kind: "activity", label: "Compacting context", status: "running" }));
    s.item("completed", "contextCompaction", "compact");
    expect(s.blocks()).toContainEqual(expect.objectContaining({ kind: "activity", status: "success" }));
    s.notify("turn/completed", { turn: { id: "turn", status: "completed" } });
    s.notify("thread/compacted", { turnId: "turn" });
    expect(s.blocks().filter((b) => b.kind === "activity")).toHaveLength(1);
    await s.handle.send("Next turn");
    expect(s.requests.filter((r) => r === "turn/start")).toHaveLength(2);
  } finally {
    await s.close();
  }
});

it("tracks image generation, exposes its saved preview, and preserves it on replay", async () => {
  const s = await server();
  try {
    s.item("started", "imageGeneration", "image", { status: "inProgress" });
    expect(s.blocks().find((b) => b.id === "activity-image")).toMatchObject({ activityKind: "image_generation", status: "running", label: "Generating image" });
    s.item("completed", "imageGeneration", "image", { status: "completed", savedPath: "/tmp/logo.png", revisedPrompt: "Logo", result: "large-base64" });
    expect(s.blocks().find((b) => b.id === "activity-image")).toMatchObject({
      activityKind: "image_generation",
      status: "success",
      label: "Generated image",
      imagePath: "/tmp/logo.png",
      detail: expect.objectContaining({ revisedPrompt: "Logo", savedPath: "/tmp/logo.png" }),
    });
    expect(s.blocks().find((b) => b.id === "activity-image")).not.toHaveProperty("detail.result");
    await s.close();
    const before = structuredClone(s.blocks());
    resetTranscripts();
    vi.mocked(core.call).mockResolvedValue({ events: s.ledger, fromTurn: 0, live: false });
    await hydrate("run");
    expect(s.blocks()).toEqual(before);
  } finally {
    await s.close();
  }
});
