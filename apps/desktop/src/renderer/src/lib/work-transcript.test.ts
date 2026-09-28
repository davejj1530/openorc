import { beforeEach, expect, it, vi } from "vitest";
import type { AgentEvent } from "@openorc/protocol";
import { applyFrame, getRun, hydrate, resetTranscripts, type Block } from "./transcript";
import { core } from "./rpc";
import { workParts, workTiming, workTurns } from "./work-transcript";
vi.mock("./rpc", () => ({ core: { onFrame: vi.fn(), call: vi.fn() } }));
beforeEach(() => resetTranscripts());
const tool: Block = { id: "read", kind: "tool", name: "read_file", input: { path: "file.ts" }, done: true };
const reply: Block = { id: "reply", kind: "message", role: "assistant", text: "Finished", streaming: false };

it("uses actual turn timing and keeps warm-session boundaries identical after history hydration", async () => {
  const events: AgentEvent[] = [
    { type: "session.started", ts: 1000, runId: "run", agent: "codex", externalSessionId: "provider", model: null },
    { type: "message.completed", ts: 1100, runId: "run", messageId: "ask", role: "user", text: "Read" },
    { type: "tool.started", ts: 2000, runId: "run", toolCallId: "read", name: "read_file", input: {}, parentToolCallId: null },
    { type: "tool.completed", ts: 3000, runId: "run", toolCallId: "read", name: "read_file", output: "file", isError: false },
    { type: "message.completed", ts: 4000, runId: "run", messageId: "answer", role: "assistant", text: "Done" },
    { type: "turn.completed", ts: 5000, runId: "run", turnId: "one", status: "success", durationMs: 3900 },
    { type: "tool.started", ts: 8000, runId: "run", toolCallId: "next", name: "read_file", input: {}, parentToolCallId: null },
    { type: "turn.completed", ts: 12000, runId: "run", turnId: "two", status: "cancelled", durationMs: 4000 },
    { type: "session.completed", ts: 12500, runId: "run", status: "cancelled", durationMs: 11500 },
  ];
  applyFrame({ runId: "run", seq: 1, events });
  const run = getRun("run")!;
  expect(run.turnOf.get("turn-one")).toBe(0);
  expect(run.turnOf.get("next")).toBe(1);
  expect(run.blocks.find((b) => b.id === "read")).toMatchObject({ at: 2000, turnKey: "run:0", runId: "run" });
  const turns = workTurns(run.blocks);
  expect(turns).toHaveLength(2);
  expect(workTiming(turns[0]!.blocks, true)).toMatchObject({ live: false, durationMs: 3900, outcome: "success" });
  expect(workTiming(turns[1]!.blocks, true)).toMatchObject({ live: false, durationMs: 4000, outcome: "cancelled" });
  vi.mocked(core.call).mockResolvedValue({ events, fromTurn: 0, live: false });
  resetTranscripts();
  await hydrate("run");
  expect(workTurns(getRun("run")!.blocks)).toEqual(turns);
});

it("keeps final prose, questions, provider errors, media and task cards outside collapsed work", () => {
  const commentary: Block = { ...reply, id: "commentary", text: "Checking" };
  const attention: Block[] = [
    { id: "error", kind: "status", text: "Provider lost connection", tone: "bad" },
    { id: "ask", kind: "approval", approvalId: "ask", approvalKind: "user_input", input: {} },
    { id: "image", kind: "activity", label: "Image", activityKind: "image_generation", status: "success", text: "" },
    { ...tool, id: "task", name: "task_create", output: '{"id":"12345678-1234-1234-1234-123456789abc"}' },
  ];
  const parts = workParts([commentary, tool, ...attention, reply], false);
  expect(parts.work).toEqual([commentary, tool]);
  expect(parts.after).toEqual([...attention, reply]);
  expect(workParts([tool, reply], true)).toEqual({ before: [], work: [tool], after: [reply] });
});

it.each([true])("keeps failed attempts in chronological work history with live=%s", (live) => {
  const attempts: Block[] = [
    { ...tool, id: "failed", isError: true, output: "7 tests failed" },
    { ...tool, id: "status-only-error", status: "error" },
    { id: "activity-error", kind: "activity", label: "Checking", status: "error", text: "Check failed" },
    { ...tool, id: "retry", status: "success", output: "37 tests passed" },
  ];
  expect(workParts([...attempts, reply], live)).toEqual({ before: [], work: attempts, after: [reply] });
});
it("keeps steering messages visible without duplicate React keys", () => {
  const blocks: Block[] = [
    { ...tool, turnKey: "run:0" },
    { ...reply, id: "steer", role: "user", turnKey: "run:0" },
    { ...tool, id: "second", turnKey: "run:0" },
  ];
  const turns = workTurns(blocks);
  expect(new Set(turns.map((t) => t.id)).size).toBe(turns.length);
  expect(workParts(turns[1]!.blocks, true).before[0]?.id).toBe("steer");
});

it("ends a fatal run and exposes its error even when no completion event follows", () => {
  applyFrame({
    runId: "fatal",
    seq: 1,
    events: [
      { type: "tool.started", ts: 1000, runId: "fatal", toolCallId: "cmd", name: "exec", input: {}, parentToolCallId: null },
      { type: "error", ts: 2000, runId: "fatal", message: "Provider lost connection", fatal: true },
    ],
  });
  const blocks = getRun("fatal")!.blocks;
  expect(workTiming(blocks, true)).toMatchObject({ live: false, outcome: "error" });
  expect(workParts(blocks, false).after).toContainEqual(expect.objectContaining({ kind: "status", text: "Provider lost connection" }));
});
