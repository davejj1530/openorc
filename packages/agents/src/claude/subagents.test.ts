import { describe, expect, it } from "vitest";
import { AgentEvent } from "@openorc/protocol";
import { ClaudeStreamParser } from "./stream-json.js";
import fixture from "./test-fixtures/subagents.json";
import forkedSkill from "./test-fixtures/forked-skill.json";

const parse = (parser: ClaudeStreamParser, line: unknown) => parser.parseLine(JSON.stringify(line), 1000).filter((event) => event.type !== "raw");
const agent = (id: string, background = false) => ({
  type: "assistant",
  message: {
    id: `launch-${id}`,
    content: [{ type: "tool_use", id, name: "Agent", input: { description: id, prompt: "Inspect the example", subagent_type: "Explore", run_in_background: background } }],
  },
});

it.each(fixture)("attributes every real child line in $name without changing its lifecycle identity", ({ lines }) => {
  const parser = new ClaudeStreamParser("host");
  const events = lines.flatMap((line) => {
    const produced = parse(parser, line);
    if ("parent_tool_use_id" in line && line.parent_tool_use_id && !("heartbeat" in line && line.heartbeat)) {
      expect(produced.length).toBeGreaterThan(0);
      for (const event of produced) {
        if (event.type === "subagent.started") expect(event.parentSubagentId).toBe(line.parent_tool_use_id);
        else if (event.type !== "subagent.updated") expect(event.subagentId).toBe(line.parent_tool_use_id);
      }
    }
    for (const event of produced) expect(AgentEvent.safeParse(event).success).toBe(true);
    return produced;
  });
  expect(events.some((event) => event.type === "subagent.started")).toBe(true);
  expect(events.some((event) => event.type === "subagent.updated" && event.status === "completed")).toBe(true);
  expect(events.some((event) => event.type === "usage.updated" && event.subagentId)).toBe(true);
});

it("settles foreground results and leaves a background acknowledgment running until its notification", () => {
  const parser = new ClaudeStreamParser("host");
  parse(parser, agent("foreground"));
  parse(parser, agent("background", true));
  const results = parse(parser, {
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "foreground", content: [{ type: "text", text: "Found it" }] },
        { type: "tool_result", tool_use_id: "background", content: "Started asynchronously" },
      ],
    },
  });
  expect(results.filter((event) => event.type === "subagent.updated")).toEqual([expect.objectContaining({ subagentId: "foreground", status: "completed", result: "Found it" })]);
  parse(parser, { type: "system", subtype: "task_started", tool_use_id: "background", task_id: "task-b", description: "Explore", is_backgrounded: true });
  expect(parser.subagentTaskId("background")).toBe("task-b");
  expect(parse(parser, { type: "system", subtype: "task_notification", task_id: "task-b", tool_use_id: "background", status: "completed", summary: "Result" })).toEqual([
    expect.objectContaining({ type: "subagent.updated", subagentId: "background", status: "completed", result: "Result" }),
  ]);
  expect(parser.subagentTaskId("background")).toBeNull();
  expect(parse(parser, { type: "system", subtype: "task_progress", task_id: "task-b", tool_use_id: "background", description: "Late" })).toEqual([]);
});

it("follows a forked skill's agent from its Skill call to the call's result, stoppable while it works", () => {
  const parser = new ClaudeStreamParser("host");
  const handBack = forkedSkill.findIndex((line) => line.type === "user" && !("parent_tool_use_id" in line && line.parent_tool_use_id));
  const working = forkedSkill.slice(0, handBack).flatMap((line) => parse(parser, line));
  expect(working).toContainEqual(expect.objectContaining({ type: "subagent.started", subagentId: "skill-1", title: "/list-files", prompt: expect.stringContaining("Run `ls`") }));
  expect(working).toContainEqual(expect.objectContaining({ type: "tool.started", toolCallId: "bash-1", subagentId: "skill-1" }));
  expect(parser.subagentTaskId("skill-1")).toBe("task-1");
  expect(parse(parser, forkedSkill[handBack])).toContainEqual(
    expect.objectContaining({ type: "subagent.updated", subagentId: "skill-1", status: "completed", result: 'Skill "list-files" completed (forked execution).\n\nResult:\nDONE' }),
  );
  expect(parser.subagentTaskId("skill-1")).toBeNull();
});

it.each(["stopped", "failed"])("maps task notification %s without a parent completion", (status) => {
  const parser = new ClaudeStreamParser("host");
  parse(parser, agent("a", true));
  const events = parse(parser, { type: "system", subtype: "task_notification", tool_use_id: "a", status, summary: "Ended" });
  expect(events).toEqual([expect.objectContaining({ type: "subagent.updated", subagentId: "a", status, result: status === "stopped" ? undefined : "Ended" })]);
});

it("omits the duplicate initial prompt and interruption marker but keeps subsequent user input", () => {
  const parser = new ClaudeStreamParser("host");
  parse(parser, agent("a"));
  const user = (text: string) => ({ type: "user", parent_tool_use_id: "a", message: { content: [{ type: "text", text }] } });
  expect(parse(parser, user("Inspect the example"))).toEqual([]);
  expect(parse(parser, user("[Request interrupted by user]"))).toEqual([]);
  expect(parse(parser, user("Inspect the example"))).toContainEqual(expect.objectContaining({ type: "message.completed", role: "user", text: "Inspect the example" }));
});

it("does not treat a Bash parent in non-heartbeat progress as an agent or attach a session summary to the last agent", () => {
  const parser = new ClaudeStreamParser("host");
  parse(parser, { type: "assistant", message: { content: [{ type: "tool_use", id: "bash", name: "Bash", input: { command: "sleep 2" } }] } });
  const events = parse(parser, { type: "tool_progress", tool_use_id: "bash", parent_tool_use_id: "bash", tool_name: "Bash", elapsed_time_seconds: 1 });
  expect(events).toContainEqual(expect.objectContaining({ type: "tool.updated", toolCallId: "bash" }));
  expect(events.some((event) => event.subagentId)).toBe(false);
  expect(parse(parser, { type: "tool_progress", tool_use_id: "unknown-bash", parent_tool_use_id: "unknown-bash", tool_name: "Bash", elapsed_time_seconds: 1 }).some((event) => event.subagentId)).toBe(
    false,
  );
  parse(parser, agent("a"));
  expect(parse(parser, { type: "system", subtype: "task_summary", detail: "Two agents are working" })).toEqual([]);
});

it("restores a SendMessage task alias in a new provider process without replaying old file content", () => {
  const parser = new ClaudeStreamParser("host2", { resumedSubagents: [{ nativeId: "agent", taskId: "task", title: "Inspect", parentSubagentId: "outer", endedAt: 500 }] });
  expect(parser.transcriptTargets()).toEqual([]);
  const events = parse(parser, { type: "system", subtype: "task_started", task_type: "local_agent", tool_use_id: "send", task_id: "task", run_id: "new-run" });
  expect(events).toContainEqual(expect.objectContaining({ type: "subagent.started", subagentId: "agent", title: "Inspect" }));
  expect(parser.subagentTaskId("agent")).toBe("task");
  const target = parser.transcriptTargets()[0]!;
  const line = { type: "assistant", uuid: "old", message: { content: [{ type: "text", text: "Old answer" }] } };
  expect(parser.transcriptMessage(target, line, 400)).toEqual([]);
  expect(parser.transcriptMessage(target, { ...line, uuid: "new" }, 600)).toContainEqual(expect.objectContaining({ type: "message.completed", subagentId: "agent" }));
  const followup = parser.transcriptMessage(target, { type: "user", uuid: "followup", message: { content: [{ type: "text", text: "Now inspect the second file." }] } }, 601);
  expect(followup).toContainEqual(expect.objectContaining({ type: "message.completed", role: "user", text: "Now inspect the second file." }));
  expect(followup.some((event) => event.type === "subagent.started")).toBe(false);
});

it("ignores orphan completion for a restored task before its new run starts", () => {
  const parser = new ClaudeStreamParser("host2", { resumedSubagents: [{ nativeId: "a", taskId: "task", title: "Inspect", endedAt: 500 }] });
  expect(parse(parser, { type: "system", subtype: "task_notification", task_id: "task", tool_use_id: "a", status: "stopped" })).toEqual([]);
});

it("suppresses the original prompt echoed on stdout after disk, but preserves an in-process follow-up", () => {
  const parser = new ClaudeStreamParser("host");
  parse(parser, agent("parent"));
  parse(parser, { ...agent("nested", true), parent_tool_use_id: "parent" });
  const started = { type: "system", subtype: "task_started", task_id: "task", tool_use_id: "nested", spawn_depth: 2, run_id: "one" };
  parse(parser, started);
  const target = parser.transcriptTargets().find((t) => t.agentId === "task")!;
  const original = { type: "user", uuid: "prompt", parent_tool_use_id: "nested", message: { content: [{ type: "text", text: "Original full assignment" }] } };
  expect(parser.transcriptMessage(target, original, 1000)).toContainEqual(expect.objectContaining({ type: "subagent.started", prompt: "Original full assignment" }));
  expect(parse(parser, original)).toEqual([]);
  parse(parser, { ...started, subtype: "task_notification", status: "completed" });
  parse(parser, { ...started, run_id: "two" });
  const next = parser.transcriptMessage(target, { ...original, uuid: "followup", message: { content: [{ type: "text", text: "Follow-up" }] } }, 2000);
  expect(next).toContainEqual(expect.objectContaining({ type: "message.completed", text: "Follow-up", role: "user" }));
  expect(next.some((e) => e.type === "subagent.started")).toBe(false);
});

it("keeps an initially foreground agent running when Claude moves it to the background", () => {
  const parser = new ClaudeStreamParser("host");
  parse(parser, agent("a"));
  parse(parser, { type: "system", subtype: "task_started", tool_use_id: "a", task_id: "task-a", is_backgrounded: false });
  parse(parser, { type: "system", subtype: "task_updated", task_id: "task-a", patch: { is_backgrounded: true } });
  const acknowledgment = parse(parser, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: "Moved to background" }] } });
  expect(acknowledgment.map((event) => event.type)).toEqual(["tool.completed"]);
  expect(parser.subagentTaskId("a")).toBe("task-a");
});

it("keeps child thinking, tool results, progress and usage separate from an interleaved parent stream", () => {
  const parser = new ClaudeStreamParser("host");
  parse(parser, agent("a"));
  parse(parser, { type: "stream_event", event: { type: "message_start", message: { id: "parent-message" } } });
  parse(parser, { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } });
  const child = parse(parser, {
    type: "assistant",
    parent_tool_use_id: "a",
    message: {
      id: "child-message",
      content: [
        { type: "thinking", thinking: "Consider the example" },
        { type: "text", text: "Inspecting" },
        { type: "tool_use", id: "read", name: "Read", input: { file_path: "src/example.ts" } },
      ],
      usage: { input_tokens: 20, output_tokens: 10 },
    },
  });
  expect(child.map((event) => event.type)).toEqual(["thinking.started", "thinking.completed", "message.completed", "tool.started", "usage.updated"]);
  expect(child.every((event) => event.subagentId === "a")).toBe(true);
  const parent = parse(parser, { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Still here" } } });
  expect(parent).toEqual([expect.objectContaining({ type: "thinking.delta", messageId: "parent-message", text: "Still here" })]);
  const result = parse(parser, { type: "user", parent_tool_use_id: "a", message: { content: [{ type: "tool_result", tool_use_id: "read", content: "Example" }] } });
  expect(result).toEqual([expect.objectContaining({ type: "tool.completed", subagentId: "a", name: "Read" })]);
  const summary = parse(parser, { type: "system", subtype: "task_summary", detail: "Parent step" });
  expect(summary).toEqual([]);
  expect(parse(parser, { type: "system", subtype: "task_started", tool_use_id: "read", task_id: "child-shell", task_type: "local_bash" })).toEqual([]);
});

it("keeps nested launches and their completion addressed to the nested agent", () => {
  const parser = new ClaudeStreamParser("host");
  parse(parser, agent("a"));
  const nested = parse(parser, { ...agent("b"), parent_tool_use_id: "a" });
  expect(nested).toEqual([
    expect.objectContaining({ type: "tool.started", subagentId: "a", toolCallId: "b" }),
    expect.objectContaining({ type: "subagent.started", subagentId: "b", parentSubagentId: "a", toolCallId: "b" }),
  ]);
  const result = parse(parser, { type: "user", parent_tool_use_id: "a", message: { content: [{ type: "tool_result", tool_use_id: "b", content: "Nested result" }] } });
  expect(result).toEqual([
    expect.objectContaining({ type: "tool.completed", subagentId: "a", toolCallId: "b" }),
    expect.objectContaining({ type: "subagent.updated", subagentId: "b", status: "completed" }),
  ]);
});

it("routes Bash heartbeats to the real tool instead of inventing a child thread", () => {
  const parser = new ClaudeStreamParser("host");
  parse(parser, { type: "assistant", message: { content: [{ type: "tool_use", id: "shell", name: "Bash", input: {} }] } });
  const heartbeat = { type: "tool_progress", tool_use_id: "shell-heartbeat-0", tool_name: "Bash", parent_tool_use_id: "shell", elapsed_time_seconds: 30, heartbeat: true };
  expect(parse(parser, heartbeat)).toEqual([expect.objectContaining({ type: "tool.updated", toolCallId: "shell", progress: "Running for 30s" })]);
  expect(parse(parser, heartbeat).some((event) => event.subagentId)).toBe(false);
  parse(parser, agent("a"));
  parse(parser, { type: "assistant", parent_tool_use_id: "a", message: { content: [{ type: "tool_use", id: "shell", name: "Bash", input: {} }] } });
  expect(parse(parser, heartbeat)).toEqual([expect.objectContaining({ type: "tool.updated", toolCallId: "shell", subagentId: "a" })]);
});

it("links a nested task before its launch arrives from the parent's transcript file", () => {
  const parser = new ClaudeStreamParser("host");
  parse(parser, agent("parent"));
  parse(parser, { type: "system", subtype: "task_started", task_type: "local_agent", tool_use_id: "parent", task_id: "parent-task" });
  expect(
    parse(parser, {
      type: "system",
      subtype: "task_started",
      task_type: "local_agent",
      tool_use_id: "nested",
      task_id: "nested-task",
      parent_task_id: "parent-task",
      spawn_depth: 2,
      description: "Nested review",
    }),
  ).toContainEqual(expect.objectContaining({ type: "subagent.started", subagentId: "nested", parentSubagentId: "parent", title: "Nested review" }));
  expect(parser.transcriptTargets()).toContainEqual(expect.objectContaining({ kind: "agent", agentId: "nested-task", subagentId: "nested", finished: false }));
  expect(parse(parser, { type: "system", subtype: "task_started", task_type: "local_bash", tool_use_id: "shell", task_id: "shell-task", parent_task_id: "parent-task", spawn_depth: 2 })).toEqual([]);
});

it.each(["a", "send-message"])("reopens a task resumed by %s and rejects the previous native run's frames", (toolId) => {
  const parser = new ClaudeStreamParser("host");
  parse(parser, agent("a", true));
  const started = { type: "system", subtype: "task_started", task_id: "task-a", task_type: "local_agent", tool_use_id: "a", run_id: "one", spawn_depth: 2 };
  parse(parser, started);
  parse(parser, { ...started, subtype: "task_notification", status: "completed", summary: "First answer" });
  const resumed = parse(parser, { ...started, tool_use_id: toolId, run_id: "two" });
  expect(resumed).toContainEqual(expect.objectContaining({ type: "subagent.updated", subagentId: "a", status: "running", taskId: "task-a" }));
  expect(parser.subagentTaskId("a")).toBe("task-a");
  expect(parser.transcriptTargets()).toContainEqual(expect.objectContaining({ agentId: "task-a", finished: false }));
  expect(parse(parser, { ...started, subtype: "task_notification", status: "failed" })).toEqual([]);
  expect(parse(parser, { ...started })).toEqual([]);
  expect(parser.subagentTaskId("a")).toBe("task-a");
  expect(parse(parser, { type: "assistant", parent_tool_use_id: "a", run_id: "one", message: { id: "stale", content: [{ type: "text", text: "Stale" }] } })).toEqual([]);
  expect(parse(parser, { type: "assistant", parent_tool_use_id: toolId, run_id: "two", message: { id: "new", content: [{ type: "text", text: "Second answer" }] } })).toContainEqual(
    expect.objectContaining({ subagentId: "a", text: "Second answer" }),
  );
});

it("deduplicates a nested record arriving from both disk and stdout using its native uuid", () => {
  const parser = new ClaudeStreamParser("host");
  parse(parser, agent("parent"));
  parse(parser, { ...agent("nested", true), parent_tool_use_id: "parent" });
  parse(parser, { type: "system", subtype: "task_started", task_id: "nested-task", tool_use_id: "nested", spawn_depth: 2 });
  const record = { type: "assistant", uuid: "record", parent_tool_use_id: "nested", message: { id: "api-message", content: [{ type: "text", text: "Only once" }] } };
  const target = parser.transcriptTargets().find((t) => t.agentId === "nested-task")!;
  const events = [...parser.transcriptMessage(target, record, 1000), ...parse(parser, record)];
  expect(events.filter((e) => e.type === "message.completed")).toHaveLength(1);
});

it("claims a workflow agent's early nested task without leaving a parent activity running", () => {
  const parser = new ClaudeStreamParser("host");
  parse(parser, { type: "system", subtype: "task_started", tool_use_id: "workflow", task_id: "wf", task_type: "local_workflow" });
  parse(parser, { type: "system", subtype: "task_progress", task_id: "wf", workflow_progress: [{ type: "workflow_agent", index: 1, agentId: "wf-agent", state: "start" }] });
  const early = parse(parser, { type: "system", subtype: "task_started", task_type: "local_agent", task_id: "nested-task", tool_use_id: "nested", run_id: "one", description: "Nested" });
  const launch = parser.workflowMessage("wf-agent", { ...agent("nested"), uuid: "launch" }, 1001);
  const end = parse(parser, { type: "system", subtype: "task_notification", task_id: "nested-task", tool_use_id: "nested", run_id: "one", status: "completed", summary: "Done" });
  expect([...early, ...launch, ...end].filter((e) => e.type === "activity.updated" && e.status === "running")).toEqual([]);
  expect(end).toContainEqual(expect.objectContaining({ type: "subagent.updated", subagentId: "nested", status: "completed" }));
  expect(launch).toContainEqual(expect.objectContaining({ type: "subagent.started", subagentId: "nested", parentSubagentId: "workflow:1" }));
});

it("does not reopen a turnless child on a late task start after Stop, but accepts a new task run", () => {
  const parser = new ClaudeStreamParser("host");
  parse(parser, agent("a", true));
  expect(parser.stoppedSubagents()).toEqual([expect.objectContaining({ subagentId: "a", status: "stopped" })]);
  const started = { type: "system", subtype: "task_started", task_type: "local_agent", tool_use_id: "a", task_id: "task", run_id: "late" };
  expect(parse(parser, started)).toEqual([]);
  expect(parser.subagentTaskId("a")).toBeNull();
  expect(parse(parser, { ...started, run_id: "resumed" })).toContainEqual(expect.objectContaining({ subagentId: "a", status: "running" }));
  expect(parser.subagentTaskId("a")).toBe("task");
});

describe("a command typed into the message and run forked, as /code-review", () => {
  // As Claude Code 2.1.318 streams it: the task only as housekeeping, the agent's messages under `forked-command-<name>`.
  const started = {
    type: "system",
    subtype: "task_started",
    task_id: "task-1",
    run_id: "run-1",
    description: "/code-review",
    subagent_type: "general-purpose",
    task_type: "local_agent",
    prompt: "Review the diff.",
    ambient: true,
    skip_transcript: true,
  };
  const ended = (status: string) => ({ type: "system", subtype: "task_notification", task_id: "task-1", run_id: "run-1", status, summary: "/code-review", ambient: true, skip_transcript: true });
  const prompt = {
    type: "user",
    parent_tool_use_id: "forked-command-code-review",
    agent_id: "task-1",
    uuid: "prompt-1",
    message: { role: "user", content: [{ type: "text", text: "Review the diff." }] },
  };
  const reply = {
    type: "assistant",
    parent_tool_use_id: "forked-command-code-review",
    agent_id: "task-1",
    uuid: "reply-1",
    message: { id: "reply-1", role: "assistant", content: [{ type: "text", text: "No findings." }] },
  };
  const result = (isError = false) => ({ type: "result", subtype: "success", is_error: isError, result: "Done", duration_ms: 1 });
  const lifecycle = (events: AgentEvent[]) =>
    events.flatMap((event) => {
      if (event.type === "subagent.started") return [`started ${event.title}`];
      return event.type === "subagent.updated" && event.status ? [event.status] : [];
    });

  it("is one titled agent that ends with its task, even when the task ended before the agent's first message", () => {
    const parser = new ClaudeStreamParser("host");
    const events = [started, ended("failed"), prompt, result()].flatMap((line) => parse(parser, line));
    expect(lifecycle(events)).toEqual(["started /code-review", "failed"]);
  });

  it("ends with its task in the order a run that reached the model streams", () => {
    const parser = new ClaudeStreamParser("host");
    const events = [started, prompt, reply, ended("completed"), result()].flatMap((line) => parse(parser, line));
    expect(lifecycle(events)).toEqual(["started /code-review", "completed"]);
    expect(events.find((event) => event.type === "message.completed" && event.role === "assistant")).toMatchObject({ subagentId: "forked-command-code-review" });
  });

  it("ends with the turn when no end of its task arrives", () => {
    const parser = new ClaudeStreamParser("host");
    const events = [prompt, reply, result(true)].flatMap((line) => parse(parser, line));
    expect(lifecycle(events)).toEqual(["started /code-review", "failed"]);
  });

  it("ends with its task when typed after other turns of a long-lived session, as the app runs it", () => {
    // As Claude Code 2.1.319 streams it there: the task starts and ends as housekeeping, then the turn's init, the
    // agent's lines replayed under the command, and the command's output as the host's reply.
    const init = { type: "system", subtype: "init", session_id: "session", model: "claude-fixture" };
    const hostReply = (text: string) => ({ type: "assistant", parent_tool_use_id: null, uuid: `host-${text}`, message: { id: `host-${text}`, role: "assistant", content: [{ type: "text", text }] } });
    const parser = new ClaudeStreamParser("host");
    const earlier = [init, hostReply("Hello"), result()].flatMap((line) => parse(parser, line));
    expect(lifecycle(earlier)).toEqual([]);
    const events = [started, ended("completed"), init, prompt, reply, hostReply("14 findings"), result()].flatMap((line) => parse(parser, line));
    expect(lifecycle(events)).toEqual(["started /code-review", "completed"]);
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  });
});
