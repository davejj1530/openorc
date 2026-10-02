import { describe, expect, it, vi } from "vitest";
import { ClaudeStreamParser, usageNotice } from "./stream-json.js";
import { stripAnsi } from "../jsonrpc.js";

const line = (o: unknown) => JSON.stringify(o);

describe("ClaudeStreamParser", () => {
  it("maps a whole print-mode session onto agent events", () => {
    const p = new ClaudeStreamParser("run-1");
    const events = [
      line({ type: "system", subtype: "init", session_id: "s1", model: "claude-haiku-4-5", capabilities: ["x"], tools: ["Read", "Workflow"] }),
      line({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } }),
      line({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } } }),
      line({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } } }),
      line({
        type: "assistant",
        message: {
          id: "m1",
          role: "assistant",
          content: [
            { type: "text", text: "Hello" },
            { type: "tool_use", id: "t1", name: "Write", input: { file_path: "a.txt" } },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
      line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false }] } }),
      line({ type: "result", subtype: "success", is_error: false, duration_ms: 1200, num_turns: 2, total_cost_usd: 0.01, result: "done", usage: { input_tokens: 12, output_tokens: 8 }, uuid: "r1" }),
    ].flatMap((l) => p.parseLine(l, 1000));

    const types = events.filter((e) => e.type !== "raw").map((e) => e.type);
    expect(types).toEqual(["session.started", "turn.started", "message.delta", "message.delta", "message.completed", "tool.started", "usage.updated", "tool.completed", "turn.completed"]);

    const started = events.find((e) => e.type === "session.started");
    expect(started && started.type === "session.started" && started.externalSessionId).toBe("s1");
    expect(started && started.type === "session.started" && started.tools).toEqual(["Read", "Workflow"]);
    const tool = events.find((e) => e.type === "tool.completed");
    expect(tool && tool.type === "tool.completed" && tool.name).toBe("Write");
    const turn = events.find((e) => e.type === "turn.completed");
    expect(turn && turn.type === "turn.completed" && turn.usage?.costUsd).toBe(0.01);
    expect(p.turns).toBe(2);
    expect(events.filter((e) => e.type === "raw")).toHaveLength(7);
  });

  it("shows waiting, thinking and tool progress the way Claude Code reports them", () => {
    const p = new ClaudeStreamParser("run-5");
    const types = (lines: unknown[]) => lines.flatMap((l) => p.parseLine(line(l), 1000)).filter((e) => e.type !== "raw");
    p.parseLine(line({ type: "system", subtype: "init", session_id: "s5", model: "m" }), 1000);
    const waiting = types([{ type: "system", subtype: "status", status: "requesting" }]);
    expect(waiting).toEqual([expect.objectContaining({ type: "activity.updated", activityId: "request-1", label: "Waiting for Claude", status: "running" })]);
    const started = types([
      { type: "stream_event", event: { type: "message_start", message: { id: "m1" } } },
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } },
      { type: "system", subtype: "thinking_tokens", estimated_tokens: 50 },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me see" } } },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    ]);
    expect(started.map((e) => e.type)).toEqual(["activity.updated", "thinking.started", "thinking.delta", "thinking.completed"]);
    expect(started[0]).toMatchObject({ activityId: "request-1", status: "success" });
    expect(started.slice(1).every((e) => "messageId" in e && e.messageId === "m1")).toBe(true);
    // A tool announced by its streamed block appears at once; the assistant line brings its input; task summaries describe it.
    const tool = types([
      { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "Bash", input: {} } } },
      { type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } },
      { type: "system", subtype: "task_summary", detail: "Listing files" },
      { type: "system", subtype: "task_started", task_id: "bg1", tool_use_id: "t1", description: "Sleep for 6 seconds" },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
    ]);
    expect(tool.map((e) => e.type)).toEqual(["tool.started", "tool.updated", "tool.updated", "tool.updated", "tool.completed"]);
    expect(tool[0]).toMatchObject({ toolCallId: "t1", name: "Bash", input: {} });
    expect(tool[1]).toMatchObject({ toolCallId: "t1", input: { command: "ls" } });
    expect(tool[2]).toMatchObject({ toolCallId: "t1", progress: "Listing files" });
    expect(tool[3]).toMatchObject({ toolCallId: "t1", progress: "Sleep for 6 seconds" });
    // Background work without a tool row of its own becomes an activity; rate limits are reported, allowances are not.
    const tasks = types([
      { type: "system", subtype: "task_started", task_id: "bg2", description: "Indexing" },
      { type: "system", subtype: "task_notification", task_id: "bg2", status: "failed", summary: "Index crashed" },
      { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
      { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1789651800 } },
    ]);
    expect(tasks.map((e) => [e.type, "status" in e ? e.status : null])).toEqual([
      ["activity.updated", "running"],
      ["activity.updated", "error"],
      ["activity.updated", "error"],
    ]);
    expect(tasks[0]).toMatchObject({ activityId: "task-bg2", label: "Indexing" });
    expect(tasks[2]).toMatchObject({ label: "Rate limit reached" });
  });

  it("tells the user about a usage threshold without calling the turn a failure", () => {
    const p = new ClaudeStreamParser("run-limits");
    const types = (lines: unknown[]) => lines.flatMap((l) => p.parseLine(line(l), 1000)).filter((e) => e.type !== "raw");
    const warning = { status: "allowed_warning", resetsAt: 1789858800, rateLimitType: "seven_day", utilization: 0.8, isUsingOverage: false };
    const events = types([
      { type: "rate_limit_event", rate_limit_info: warning },
      { type: "rate_limit_event", rate_limit_info: { status: "allowed_overage", rateLimitType: "five_hour", utilization: 0.95 } },
    ]);
    // A heads-up is a system notice, keyed by its window so repeats replace it, and it
    // carries no payload: an error row with raw JSON reads as a turn that failed.
    expect(events.map((e) => e.type)).toEqual(["message.completed", "message.completed"]);
    expect(events[0]).toMatchObject({ role: "system", messageId: "rate-limit-1789858800" });
    expect(events[0]).not.toHaveProperty("detail");
    expect(usageNotice(warning, "on Sunday at 7:00 AM")).toBe("You have used 80% of your weekly limit. It resets on Sunday at 7:00 AM.");
    expect(usageNotice({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.95 }, null)).toBe("You have used 95% of your five-hour limit.");
    expect(usageNotice({ status: "allowed_warning" }, "at 9:15 PM")).toBe("You are close to your usage limit. It resets at 9:15 PM.");
  });

  it("includes the day in a weekly reset notice", () => {
    vi.stubEnv("TZ", "Asia/Manila");
    try {
      const parser = new ClaudeStreamParser("run-weekly-reset");
      const events = parser.parseLine(
        line({
          type: "rate_limit_event",
          rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.8, resetsAt: 1789858800 },
        }),
        Date.parse("2026-09-18T00:00:00Z"),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "message.completed",
          text: "You have used 80% of your weekly limit. It resets on Sunday at 7:00 AM.",
        }),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reports a manual compaction as one activity and never as a turn, and an automatic one inside its turn", () => {
    const p = new ClaudeStreamParser("run-6");
    const types = (lines: unknown[]) => lines.flatMap((l) => p.parseLine(line(l), 1000)).filter((e) => e.type !== "raw");
    p.parseLine(line({ type: "system", subtype: "init", session_id: "s6", model: "m" }), 1000);
    p.parseLine(line({ type: "result", subtype: "success", num_turns: 1, duration_ms: 1 }), 1000);
    p.expectManualCompaction();
    const manual = types([
      { type: "system", subtype: "status", status: "compacting" },
      { type: "system", subtype: "status", status: null, compact_result: "success" },
      { type: "system", subtype: "init", session_id: "s6", model: "m" },
      { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 29954, post_tokens: 1881 } },
      { type: "user", message: { role: "user", content: "This session is being continued from a previous conversation." } },
      { type: "result", subtype: "success", num_turns: 0, duration_ms: 1 },
    ]);
    expect(manual).toEqual([
      expect.objectContaining({ type: "activity.updated", activityId: "compaction-1", status: "running", detail: { mode: "manual" } }),
      expect.objectContaining({ type: "activity.updated", activityId: "compaction-1", status: "success", text: "29,954 tokens folded into 1,881.", detail: { mode: "manual" } }),
    ]);
    // The next prompt is an ordinary turn again.
    expect(types([{ type: "system", subtype: "init", session_id: "s6", model: "m" }]).map((e) => e.type)).toEqual(["turn.started"]);
    expect(types([{ type: "result", subtype: "success", num_turns: 1, duration_ms: 1 }]).map((e) => e.type)).toEqual(["turn.completed"]);
    // The CLI compacts on its own mid-turn; the turn still completes.
    const automatic = types([
      { type: "system", subtype: "init", session_id: "s6", model: "m" },
      { type: "system", subtype: "status", status: "compacting" },
      { type: "system", subtype: "status", status: null, compact_result: "success" },
      { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 5, post_tokens: 2 } },
      { type: "result", subtype: "success", num_turns: 2, duration_ms: 1 },
    ]);
    expect(automatic.map((e) => [e.type, "status" in e ? e.status : null])).toEqual([
      ["turn.started", null],
      ["activity.updated", "running"],
      ["activity.updated", "success"],
      ["turn.completed", "success"],
    ]);
    expect(automatic[1]).toMatchObject({ detail: { mode: "automatic" } });
    expect(p.turns).toBe(4);
  });

  it("never throws on garbage and marks max-turn results", () => {
    const p = new ClaudeStreamParser("run-2");
    expect(p.parseLine("not json")[0]?.type).toBe("error");
    expect(p.parseLine("")).toEqual([]);
    const [, turn] = p.parseLine(line({ type: "result", subtype: "error_max_turns", is_error: true, duration_ms: 5 }));
    expect(turn && turn.type === "turn.completed" && turn.status).toBe("error");
  });

  it("reports malformed records once and reads the next valid line", () => {
    const parser = new ClaudeStreamParser("malformed");
    const malformed = [
      null,
      42,
      [],
      { type: "stream_event", event: null },
      { type: "assistant", message: { content: [null] } },
      { type: "assistant", message: { content: null } },
      { type: "user", message: { content: [null] } },
      { type: "system", subtype: "background_tasks_changed", tasks: [null] },
      { type: "system", subtype: "background_tasks_changed", tasks: null },
    ];

    for (const value of malformed) {
      const events = parser.parseLine(line(value), 1000);
      expect(events.filter((event) => event.type === "error")).toEqual([expect.objectContaining({ type: "error", runId: "malformed", fatal: false })]);
    }

    const valid = parser.parseLine(line({ type: "assistant", message: { id: "next", content: [{ type: "text", text: "Still here" }] } }), 1001);
    expect(valid).toContainEqual(expect.objectContaining({ type: "message.completed", messageId: "next", text: "Still here" }));
    expect(parser.parseLine(line({ type: "future_event", value: { new: true } }), 1002).map((event) => event.type)).toEqual(["raw"]);
  });

  it("keeps thinking and tool identity after malformed lines in an active turn", () => {
    const parser = new ClaudeStreamParser("recover");
    const parse = (value: unknown) => parser.parseLine(line(value), 1000).filter((event) => event.type !== "raw");

    parse({ type: "stream_event", event: { type: "message_start", message: { id: "message" } } });
    expect(parse({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } })).toMatchObject([{ type: "thinking.started", messageId: "message" }]);
    expect(parse({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: null } })).toMatchObject([{ type: "error", fatal: false }]);
    expect(parse({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Continue" } } })).toMatchObject([
      { type: "thinking.delta", messageId: "message", text: "Continue" },
    ]);
    expect(parse({ type: "stream_event", event: { type: "content_block_stop", index: 0 } })).toMatchObject([{ type: "thinking.completed", messageId: "message" }]);
    expect(parse({ type: "assistant", message: { id: "message", content: [{ type: "tool_use", id: "tool", name: "Bash", input: { command: "pwd" } }] } })).toMatchObject([
      { type: "tool.started", toolCallId: "tool", name: "Bash" },
    ]);
    expect(parse({ type: "user", message: { content: [null] } })).toMatchObject([{ type: "error", fatal: false }]);
    expect(parse({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool", content: "done" }] } })).toMatchObject([
      { type: "tool.completed", toolCallId: "tool", name: "Bash", output: "done" },
    ]);
  });
  it("sizes context from each assistant line and takes the window, not the turn total, from the result", () => {
    const p = new ClaudeStreamParser("run-2");
    p.parseLine(line({ type: "system", subtype: "init", session_id: "s2", model: "claude-fable-5-1" }), 1000);
    const [usage] = p
      .parseLine(
        line({ type: "assistant", message: { id: "m1", role: "assistant", content: [], usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 400, cache_creation_input_tokens: 50 } } }),
        1000,
      )
      .filter((e) => e.type === "usage.updated");
    expect(usage && usage.type === "usage.updated" && usage.usage.contextTokens).toBe(455);
    const turn = p
      .parseLine(
        line({
          type: "result",
          subtype: "success",
          usage: { input_tokens: 12, output_tokens: 8, cache_read_input_tokens: 900 },
          modelUsage: { "claude-haiku-4-5": { contextWindow: 200000 }, "claude-fable-5-1": { contextWindow: 1000000 } },
        }),
        1000,
      )
      .find((e) => e.type === "turn.completed");
    expect(turn && turn.type === "turn.completed" && turn.usage).toEqual({ inputTokens: 12, outputTokens: 8, cacheReadTokens: 900, contextWindow: 1000000 });
    const bare = new ClaudeStreamParser("run-3");
    const old = bare.parseLine(line({ type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 } }), 1000).find((e) => e.type === "turn.completed");
    expect(old && old.type === "turn.completed" && old.usage?.contextWindow).toBeUndefined();
  });

  it("says when a run that asked for Fast is not getting it, and when Fast comes back", () => {
    const p = new ClaudeStreamParser("run-fast", { fastMode: true });
    const notices = (lines: unknown[]) => lines.flatMap((l) => p.parseLine(line(l), 1000)).filter((e) => e.type === "message.completed");
    const texts = (lines: unknown[]) => notices(lines).map((e) => (e.type === "message.completed" ? e.text : ""));
    // An account check that has not answered yet says nothing, and Fast serving the turn is not news.
    expect(
      texts([
        { type: "system", subtype: "init", session_id: "s", model: "m", fast_mode_state: "off", fast_mode_disabled_reason: "pending" },
        { type: "result", subtype: "success", num_turns: 1, duration_ms: 1, fast_mode_state: "on" },
      ]),
    ).toEqual([]);
    // Init and result lines repeat the state; only a change is reported.
    const cooldown = notices([
      { type: "system", subtype: "init", session_id: "s", model: "m", fast_mode_state: "cooldown" },
      { type: "result", subtype: "success", num_turns: 1, duration_ms: 1, fast_mode_state: "cooldown" },
      { type: "system", subtype: "init", session_id: "s", model: "m", fast_mode_state: "on" },
    ]);
    expect(cooldown.map((e) => (e.type === "message.completed" ? e.text : ""))).toEqual(["Claude is answering at standard speed until Fast mode's rate limit resets.", "Fast mode is back on."]);
    expect(cooldown.map((e) => (e.type === "message.completed" ? [e.role, e.messageId] : []))).toEqual([
      ["system", "fast-mode-run-fast-1"],
      ["system", "fast-mode-run-fast-2"],
    ]);
    expect(
      texts([
        { type: "result", subtype: "success", num_turns: 1, duration_ms: 1, fast_mode_state: "off", fast_mode_disabled_reason: "extra_usage_disabled" },
        { type: "system", subtype: "init", session_id: "s", model: "m", fast_mode_state: "off", fast_mode_disabled_reason: "extra_usage_disabled" },
        { type: "system", subtype: "notification", key: "fast-mode-overage-rejected", text: "Fast mode disabled · usage credits exhausted" },
      ]),
    ).toEqual([
      "Claude is answering at standard speed. Fast mode bills to usage credits, which are turned off for this Claude account. Turn them on in your claude.ai usage settings.",
      "Fast mode disabled · usage credits exhausted",
    ]);
  });

  it("counts background work apart from the commands left running, leaving out ambient tasks and unchanged lists", () => {
    const p = new ClaudeStreamParser("run-bg");
    const listed = (tasks: unknown[]) => p.parseLine(line({ type: "system", subtype: "background_tasks_changed", tasks }), 1000).filter((e) => e.type !== "raw");
    const workflow = { task_id: "w1", task_type: "local_workflow", description: "Trace" };
    const server = { task_id: "b1", task_type: "local_bash", description: "Serve the preview" };
    expect(listed([workflow])).toEqual([{ type: "background.updated", runId: "run-bg", ts: 1000, running: 1, commands: [] }]);
    expect(listed([workflow, { task_id: "m1", task_type: "monitor_ws", description: "Watch the build", ambient: true }])).toEqual([]);
    expect(listed([workflow, server])).toEqual([{ type: "background.updated", runId: "run-bg", ts: 1000, running: 1, commands: [{ id: "b1", description: "Serve the preview" }] }]);
    // Another piece of work in place of the first changes nothing the host counts.
    expect(listed([server, { task_id: "a1", task_type: "local_agent", description: "Review" }])).toEqual([]);
    expect(p.backgroundWork).toEqual(["a1"]);
    expect(p.backgroundCommands).toEqual([{ id: "b1", description: "Serve the preview" }]);
    expect(listed([])).toMatchObject([{ running: 0, commands: [] }]);
    expect(p.backgroundWork).toEqual([]);
    expect(p.backgroundCommands).toEqual([]);
  });

  it("stays quiet about Fast on a run that did not ask for it", () => {
    const p = new ClaudeStreamParser("run-standard");
    const events = [
      line({ type: "system", subtype: "init", session_id: "s", model: "m", fast_mode_state: "off", fast_mode_disabled_reason: "not_first_party" }),
      line({ type: "result", subtype: "success", num_turns: 1, duration_ms: 1, fast_mode_state: "off", fast_mode_disabled_reason: "sdk_opt_in_required" }),
    ].flatMap((l) => p.parseLine(l, 1000));
    expect(events.filter((e) => e.type === "message.completed")).toEqual([]);
  });
});

describe("stripAnsi", () => {
  it("removes colour codes and leaves text", () => {
    expect(stripAnsi("\x1b[2m2026-09-12\x1b[0m \x1b[31mERROR\x1b[0m worker quit")).toBe("2026-09-12 ERROR worker quit");
  });
});

describe("ClaudeAdapter", () => {
  it("ends the run when the binary cannot be spawned", async () => {
    const { ClaudeAdapter } = await import("./adapter.js");
    const handle = new ClaudeAdapter({ binary: "openorc-no-such-binary" }).start(
      { runId: "r", agent: "claude", cwd: process.cwd(), prompt: "hi", permissionMode: "trusted" },
      { revision: 0, binary: "openorc-no-such-binary", env: process.env },
    );
    const seen: string[] = [];
    handle.on("event", (ev) => seen.push(ev.type === "error" ? `error:${ev.fatal}` : ev.type));
    await handle.wait();
    expect(seen).toEqual(["error:true", "session.completed"]);
  });
});

it("attaches usage recovery only to rejected structured rate-limit events", () => {
  const parser = new ClaudeStreamParser("recovery");
  const rejected = parser.parseLine(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } }));
  expect(rejected).toContainEqual(expect.objectContaining({ type: "activity.updated", recovery: { kind: "usage", provider: "claude" } }));
  const warning = parser.parseLine(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } }));
  expect(JSON.stringify(warning)).not.toContain('"recovery":');
});
