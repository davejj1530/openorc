import { expect, it } from "vitest";
import { AgentEvent } from "@openorc/protocol";
import { ClaudeStreamParser } from "./stream-json.js";
import fixture from "./test-fixtures/workflows.json";
import live from "./test-fixtures/workflow-stream.json";

const parse = (parser: ClaudeStreamParser, line: unknown) => parser.parseLine(JSON.stringify(line), 1000).filter((event) => event.type !== "raw");
const task = (subtype: string, detail: Record<string, unknown> = {}) => ({ type: "system", subtype, tool_use_id: "workflow", task_id: "task-w", ...detail });
const progress = (parser: ClaudeStreamParser, entries: unknown[]) => parse(parser, task("task_progress", { workflow_progress: entries }));
const start = (parser: ClaudeStreamParser) => parse(parser, task("task_started", { task_type: "local_workflow", workflow_name: "Inspect queue", skip_transcript: true }));

it("labels the phase of running agents even when a later phase has been announced", () => {
  const parser = new ClaudeStreamParser("host");
  start(parser);
  const events = progress(parser, [
    { type: "workflow_phase", index: 1, title: "Inspect" },
    { type: "workflow_phase", index: 2, title: "Verify" },
    { type: "workflow_agent", index: 3, agentId: "a", state: "progress", phaseTitle: "Inspect" },
  ]);
  expect(events).toContainEqual(expect.objectContaining({ subagentId: "workflow", progress: "Phase 1 · Inspect" }));
});

it("replays the live haiku workflow, including a queued entry whose file identity arrives later", () => {
  const parser = new ClaudeStreamParser("host");
  const events = live.lines.flatMap((line) => parse(parser, line));
  const starts = events.filter((event) => event.type === "subagent.started");
  expect([...new Set(starts.map((event) => event.subagentId))]).toEqual(["workflow", "workflow:1", "workflow:2"]);
  expect(parser.workflows.targets().map((target) => [target.agentId, target.finished, target.workflowEnded])).toEqual([
    ["agent-1", true, true],
    ["agent-2", true, true],
  ]);
  expect(events.filter((event) => event.type === "subagent.updated" && event.subagentId === "workflow:2").at(-1)).toMatchObject({ status: "completed" });
  expect(events.filter((event) => event.type === "subagent.updated" && event.subagentId === "workflow").at(-1)).toMatchObject({ status: "completed" });
  expect(events.some((event) => event.type === "usage.updated")).toBe(false);
  for (const event of events) expect(AgentEvent.safeParse(event).success).toBe(true);
});

it("uses the Workflow tool call for the parent card and progress entry indices for phase-grouped children", () => {
  const parser = new ClaudeStreamParser("host");
  const launch = { type: "assistant", message: { id: "launch", content: [{ type: "tool_use", id: "workflow", name: "Workflow", input: { description: "Inspect queue", script: "workflow()" } }] } };
  expect(parse(parser, launch)).toEqual([
    expect.objectContaining({ type: "tool.started", toolCallId: "workflow", name: "Workflow" }),
    expect.objectContaining({ type: "subagent.started", subagentId: "workflow", toolCallId: "workflow", agentType: "workflow", prompt: "Inspect queue" }),
  ]);
  start(parser);
  expect(parse(parser, launch).filter((event) => event.type === "subagent.started")).toEqual([]);
  const events = progress(parser, fixture.progress);
  expect(events.filter((event) => event.type === "subagent.started").map((event) => [event.subagentId, event.parentSubagentId, event.group])).toEqual([
    ["workflow:1", "workflow", "Inspect"],
    ["workflow:2", "workflow", "Inspect"],
    ["workflow:5", "workflow", "Verify"],
  ]);
  expect(events).toContainEqual(expect.objectContaining({ subagentId: "workflow", progress: "Phase 2 · Verify" }));
  expect(events).toContainEqual(expect.objectContaining({ subagentId: "workflow:5", status: "failed", error: "Verification interrupted" }));
  expect(events.some((event) => event.type === "usage.updated")).toBe(false);
  for (const event of events) expect(AgentEvent.safeParse(event).success).toBe(true);
  expect(progress(parser, fixture.progress).filter((event) => event.type === "subagent.started")).toEqual([]);
});

it("merges deltas and retries into one child while keeping both attempt files and only whole-workflow Stop", () => {
  const parser = new ClaudeStreamParser("host");
  start(parser);
  progress(parser, [{ type: "workflow_agent", index: 1, label: "Inspect", phaseTitle: "Read", agentId: "first", state: "error", error: "Retry me" }]);
  const retry = progress(parser, [{ type: "workflow_agent", index: 1, agentId: "retry", state: "start", attempt: 2 }]);
  expect(retry).toContainEqual(expect.objectContaining({ subagentId: "workflow:1", status: "running", error: undefined }));
  expect(parser.workflows.targets().map((target) => [target.agentId, target.subagentId, target.finished])).toEqual([
    ["first", "workflow:1", true],
    ["retry", "workflow:1", false],
  ]);
  expect(parser.subagentTaskId("workflow")).toBe("task-w");
  expect(parser.subagentTaskId("workflow:1")).toBeNull();
  const ended = parse(parser, task("task_notification", { status: "completed", summary: "Done" }));
  expect(ended).toContainEqual(expect.objectContaining({ subagentId: "workflow:1", status: "stopped" }));
  expect(parser.subagentTaskId("workflow")).toBeNull();
  const late = progress(parser, [{ type: "workflow_agent", index: 1, state: "progress" }]);
  expect(late).toContainEqual(expect.objectContaining({ subagentId: "workflow:1", status: "stopped" }));
});

it("maps real transcript blocks to the nested agent, replaces the prompt, and upgrades the final preview", () => {
  const parser = new ClaudeStreamParser("host");
  start(parser);
  progress(parser, fixture.progress);
  const events = fixture.transcript.flatMap((line) => parser.workflowMessage("agent-1", line, 1000)).filter((event) => event.type !== "raw");
  expect(events.every((event) => event.subagentId === "workflow:1")).toBe(true);
  expect(events.filter((event) => event.type === "message.completed" && event.role === "user")).toEqual([]);
  expect(events).toContainEqual(expect.objectContaining({ type: "subagent.started", prompt: "Read README.md and queue.ts, then report the full result." }));
  expect(events).toContainEqual(expect.objectContaining({ type: "tool.started", name: "Read" }));
  expect(events).toContainEqual(expect.objectContaining({ type: "tool.completed", name: "Read" }));
  expect(events).toContainEqual(expect.objectContaining({ type: "subagent.updated", result: "The complete result: the queue waits one frame before reading." }));
  for (const event of events) expect(AgentEvent.safeParse(event).success).toBe(true);
});

it("settles a workflow whose tool fails before it gets a task id", () => {
  const parser = new ClaudeStreamParser("host");
  parse(parser, { type: "assistant", message: { content: [{ type: "tool_use", id: "workflow", name: "Workflow", input: {} }] } });
  expect(parse(parser, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "workflow", is_error: true, content: "Invalid script" }] } })).toContainEqual(
    expect.objectContaining({ type: "subagent.updated", subagentId: "workflow", status: "failed" }),
  );
});

it("ignores unchanged snapshots and replaces retry entries without stale progress", () => {
  const parser = new ClaudeStreamParser("host");
  start(parser);
  progress(parser, fixture.progress);
  expect(progress(parser, fixture.progress)).toEqual([]);
  expect(
    progress(
      parser,
      fixture.progress.map((entry) => ({ ...entry, tokens: 4500, lastProgressAt: 9999, durationMs: 5000 })),
    ),
  ).toEqual([]);
  const fail = { type: "workflow_agent", index: 1, label: "Inspect", state: "error", agentId: "first", error: "Old error", lastToolSummary: "Old progress" };
  progress(parser, [fail]);
  const retry = progress(parser, [{ type: "workflow_agent", index: 1, label: "Inspect", state: "start", agentId: "retry" }]);
  expect(retry).toContainEqual(expect.objectContaining({ subagentId: "workflow:1", status: "running", progress: undefined, error: undefined }));
});

it("shows the workflow name and description and only the computed task text in its agents", () => {
  const parser = new ClaudeStreamParser("host");
  const events = parse(parser, task("task_started", { task_type: "local_workflow", workflow_name: "Inspect", description: "Inspect the queue", prompt: "export const meta = {}" }));
  expect(events.filter((e) => e.type === "subagent.started").at(-1)).toMatchObject({ prompt: "Inspect\n\nInspect the queue" });
  progress(parser, [{ type: "workflow_agent", index: 1, agentId: "one", state: "start" }]);
  const prompt = "[Workflow harness — computed task] The task text below was computed at runtime by a workflow script. The computed task text follows:\n  Read README.md.\n  Report its title.";
  expect(parser.workflowMessage("one", { type: "user", uuid: "prompt", message: { content: prompt } }, 1000)).toContainEqual(
    expect.objectContaining({ type: "subagent.started", prompt: "Read README.md.\nReport its title." }),
  );
});
