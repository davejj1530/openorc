import { expect, it } from "vitest";
import { applyEvents, emptyRun } from "./transcript.js";
import { subagentGroups } from "./transcript-subagents.js";
import { workParts, workTiming } from "./work-transcript.js";
import { turnStatus, turnStatusWords } from "./turn-model.js";
import { AgentEvent } from "@openorc/protocol";
import opencodeChild from "./test-fixtures/opencode-child-events.json";

it("renders the recorded OpenCode commentary and answer once when completion repeats the entire turn", () => {
  const run = emptyRun("child");
  applyEvents(
    run,
    opencodeChild.map((event) => AgentEvent.parse(event)),
  );
  const replies = run.blocks.filter((block) => block.kind === "message" && block.role === "assistant");
  expect(replies).toHaveLength(2);
  expect(replies[0]).toMatchObject({ text: "I'll follow the steps in order.\n\n" });
  expect(replies[1]).toMatchObject({ text: expect.stringContaining('The README, titled "Retry queue,"') });
});

it("replaces a native launch row, survives acknowledgment and parent completion, then settles from lifecycle", () => {
  const run = emptyRun("host");
  const base = { runId: "host", ts: 10 };
  applyEvents(run, [
    { ...base, type: "tool.started", toolCallId: "launch", name: "Agent", input: {}, parentToolCallId: null },
    { ...base, type: "subagent.started", subagentId: "a", toolCallId: "launch", threadId: "child", title: "Explore", prompt: "Find the cause" },
    { ...base, type: "tool.completed", toolCallId: "launch", name: "Agent", output: "Started in background", isError: false },
    { ...base, type: "turn.completed", turnId: "parent", status: "success", durationMs: 1 },
    { ...base, type: "subagent.updated", subagentId: "a", threadId: "child", progress: "Reading source" },
  ]);
  expect(run.blocks.filter((block) => block.kind === "tool")).toHaveLength(1);
  expect(run.blocks[0]).toMatchObject({ id: "launch", done: false, subagent: { status: "running", progress: "Reading source", prompt: "Find the cause" } });
  applyEvents(run, [{ ...base, ts: 30, type: "subagent.updated", subagentId: "a", threadId: "child", status: "completed", result: "Found it" }]);
  expect(run.blocks[0]).toMatchObject({ done: true, turnKey: "host:0", subagent: { status: "completed", endedAt: 30, result: "Found it" } });
  expect(workParts(run.blocks, false).after[0]).toBe(run.blocks[0]);
  expect(workParts(run.blocks, false).work).not.toContain(run.blocks[0]);
  applyEvents(run, [{ ...base, ts: 40, type: "subagent.updated", subagentId: "a", threadId: "child", status: "running" }]);
  expect(run.blocks[0]).toMatchObject({ subagent: { result: undefined, progress: undefined, startedAt: 40, endedAt: null } });
  applyEvents(run, [{ ...base, ts: 50, type: "subagent.updated", subagentId: "a", threadId: "child", status: "stopped", result: "Description" }]);
  expect(run.blocks[0]).toMatchObject({ subagent: { result: undefined } });
});

it("groups parallel children once, with independent states and no extra launch row when lifecycle arrives first", () => {
  const run = emptyRun("host");
  const base = { runId: "host", ts: 10 };
  applyEvents(run, [
    { ...base, type: "subagent.started", subagentId: "a", toolCallId: "launch-a", threadId: "child-a", title: "A" },
    { ...base, type: "tool.started", toolCallId: "launch-a", name: "Agent", input: {}, parentToolCallId: null },
    { ...base, type: "subagent.started", subagentId: "b", toolCallId: "launch-b", threadId: "child-b", title: "B" },
    { ...base, type: "subagent.updated", subagentId: "a", threadId: "child-a", status: "stopped" },
    { ...base, type: "subagent.updated", subagentId: "b", threadId: "child-b", status: "failed", error: "Unavailable" },
  ]);
  expect(run.blocks).toHaveLength(2);
  expect([...subagentGroups(run.blocks).values()].map((group) => group.length)).toEqual([2]);
  expect(run.blocks[0]).toMatchObject({ status: "cancelled", subagent: { status: "stopped" } });
  expect(run.blocks[1]).toMatchObject({ status: "error", subagent: { result: "Unavailable" } });
  applyEvents(run, [{ ...base, type: "subagent.updated", subagentId: "a", threadId: "child-a", status: "running" }]);
  expect(run.blocks[0]).toMatchObject({ done: false, subagent: { endedAt: null } });
});

it("leaves old flat child tools readable without inventing a thread link", () => {
  const run = emptyRun("old");
  applyEvents(run, [{ runId: "old", ts: 1, type: "tool.started", toolCallId: "child", parentToolCallId: "agent", name: "Read", input: {} }]);
  expect(run.blocks[0]).toMatchObject({ kind: "tool", name: "Read" });
  expect(subagentGroups(run.blocks).size).toBe(0);
});

it("shows a hosted child's completion answer when Claude omitted its final assistant message", () => {
  const run = emptyRun("child");
  applyEvents(run, [
    { type: "message.completed", runId: "child", ts: 1, messageId: "prompt", role: "user", text: "Survey MCP handling" },
    { type: "turn.started", runId: "child", ts: 1, turnId: "subagent:native" },
    { type: "message.completed", runId: "child", ts: 2, messageId: "commentary", role: "assistant", text: "Investigating." },
    { type: "turn.completed", runId: "child", ts: 4, turnId: "subagent:native", status: "success", durationMs: 3, resultText: "The full MCP survey." },
  ]);
  expect(run.blocks).toContainEqual(expect.objectContaining({ kind: "message", role: "assistant", text: "The full MCP survey.", turnKey: "child:0" }));
  applyEvents(run, [{ type: "message.completed", runId: "child", ts: 3, messageId: "disk-final", role: "assistant", text: "The full MCP survey." }]);
  expect(run.blocks.filter((block) => block.kind === "message" && block.text === "The full MCP survey.")).toHaveLength(1);
  expect(run.blocks.at(-1)).toMatchObject({ kind: "status", boundary: "turn" });
  expect(run.blocks.find((block) => block.id === "disk-final")).toMatchObject({ turnKey: "child:0" });
  applyEvents(run, [
    { type: "turn.started", runId: "child", ts: 5, turnId: "subagent:native" },
    { type: "message.completed", runId: "child", ts: 6, messageId: "retry", role: "assistant", text: "Next attempt." },
  ]);
  expect(run.blocks.at(-1)).toMatchObject({ id: "retry", turnKey: "child:1" });
  applyEvents(run, [{ type: "turn.completed", runId: "child", ts: 7, turnId: "subagent:native", status: "success", durationMs: 2, resultText: "Next attempt." }]);
  expect(run.blocks.filter((block) => block.kind === "status").map((block) => block.turnKey)).toEqual(["child:0", "child:1"]);
});

it("does not repeat an already streamed child answer or promote a root completion summary", () => {
  for (const turnId of ["subagent:native", "root"]) {
    const run = emptyRun("run");
    applyEvents(run, [
      { type: "message.completed", runId: "run", ts: 1, messageId: "answer", role: "assistant", text: "Done." },
      { type: "turn.completed", runId: "run", ts: 2, turnId, status: "success", durationMs: 1, resultText: turnId === "root" ? "Root summary" : "Done." },
    ]);
    expect(run.blocks.filter((block) => block.kind === "message")).toHaveLength(1);
  }
});

it("groups workflow cards by phase while preserving their identity through retries", () => {
  const run = emptyRun("workflow");
  const base = { runId: "workflow", ts: 10 };
  applyEvents(run, [
    { ...base, type: "subagent.started", subagentId: "a", threadId: "child-a", title: "A", group: "Inspect" },
    { ...base, type: "subagent.started", subagentId: "b", threadId: "child-b", title: "B", group: "Inspect" },
    { ...base, type: "subagent.started", subagentId: "c", threadId: "child-c", title: "C", group: "Verify" },
    { ...base, type: "subagent.updated", subagentId: "a", threadId: "child-a", status: "failed" },
    { ...base, type: "subagent.started", subagentId: "a", threadId: "child-a", title: "A retry", group: "Inspect" },
    { ...base, type: "subagent.updated", subagentId: "a", threadId: "child-a", status: "running" },
  ]);
  expect([...subagentGroups(run.blocks).values()].map((group) => group.map((block) => block.subagent?.title))).toEqual([["A retry", "B"], ["C"]]);
});

it("renders child Stop notices as quiet status lines without a user message", () => {
  const run = emptyRun("host");
  applyEvents(run, [{ type: "subagent.updated", runId: "host", ts: 3, subagentId: "child", notice: "Stopped Checker" }]);
  expect(workParts(run.blocks, true).after).toEqual([expect.objectContaining({ kind: "status", tone: "muted", text: "Stopped Checker" })]);
});

it("presents missing child updates as neutral instead of an error", () => {
  const run = emptyRun("host");
  applyEvents(run, [{ type: "subagent.updated", runId: "host", ts: 3, subagentId: "child", threadId: "child-thread", status: "no_updates" }]);
  expect(run.blocks).toEqual([expect.objectContaining({ kind: "tool", done: true, isError: false, status: "disconnected", subagent: expect.objectContaining({ status: "no_updates" }) })]);
  const child = emptyRun("child");
  applyEvents(child, [{ type: "turn.completed", runId: "child", ts: 4, turnId: "subagent:child", status: "cancelled", observationEnded: true, durationMs: 1 }]);
  expect(child.blocks[0]).toMatchObject({ tone: "muted", outcome: "no_updates", text: "Updates stopped" });
  expect(turnStatusWords(turnStatus({ ...workTiming(child.blocks, false), writing: false }, 4))).toBe("No updates");
});
