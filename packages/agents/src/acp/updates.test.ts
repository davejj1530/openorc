import { describe, expect, it } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { AcpUpdateMapper } from "./updates.js";

const text = (t: string) => ({ type: "text" as const, text: t });

describe("AcpUpdateMapper", () => {
  it("streams assistant text as one message per id and closes it when the turn ends", () => {
    const mapper = new AcpUpdateMapper("run");
    const first = mapper.map({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: text("Hel") }, 1);
    const second = mapper.map({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: text("lo") }, 2);
    expect([...first, ...second]).toEqual([
      { type: "message.delta", runId: "run", ts: 1, messageId: "m1", role: "assistant", text: "Hel" },
      { type: "message.delta", runId: "run", ts: 2, messageId: "m1", role: "assistant", text: "lo" },
    ]);
    const ended = mapper.endTurn(3);
    expect(ended.events).toEqual([{ type: "message.completed", runId: "run", ts: 3, messageId: "m1", role: "assistant", text: "Hello" }]);
    expect(ended.text).toBe("Hello");
  });

  it("closes a message when the next one starts and brackets reasoning with started and completed", () => {
    const mapper = new AcpUpdateMapper("run");
    mapper.map({ sessionUpdate: "agent_thought_chunk", messageId: "t1", content: text("hmm") }, 1);
    mapper.map({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: text("A") }, 2);
    const events = mapper.map({ sessionUpdate: "agent_message_chunk", messageId: "m2", content: text("B") }, 3);
    expect(events.map((e) => e.type)).toEqual(["message.completed", "message.delta"]);
    const ended = mapper.endTurn(4);
    expect(ended.events.map((e) => e.type)).toEqual(["message.completed", "thinking.completed"]);
    expect(ended.text).toBe("A\n\nB");
  });

  it("turns tool calls into started, output deltas from replaced snapshots, and completed", () => {
    const mapper = new AcpUpdateMapper("run");
    const started = mapper.map({ sessionUpdate: "tool_call", toolCallId: "c1", title: "ls", kind: "execute", status: "pending", rawInput: { command: "ls", cwd: "/repo" } }, 1);
    expect(started).toEqual([{ type: "tool.started", runId: "run", ts: 1, toolCallId: "c1", name: "shell", input: { command: "ls", cwd: "/repo" }, parentToolCallId: null }]);
    const running: SessionUpdate = { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress", content: [{ type: "content", content: text("a\n") }] };
    expect(mapper.map(running, 2)).toEqual([{ type: "tool.output.delta", runId: "run", ts: 2, toolCallId: "c1", text: "a\n" }]);
    const more: SessionUpdate = { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress", content: [{ type: "content", content: text("a\nb\n") }] };
    expect(mapper.map(more, 3)).toEqual([{ type: "tool.output.delta", runId: "run", ts: 3, toolCallId: "c1", text: "b\n" }]);
    // The same snapshot again is not new output.
    expect(mapper.map(more, 4)).toEqual([]);
    const done: SessionUpdate = { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", rawOutput: { output: "a\nb\n", metadata: { exit: 0 } } };
    expect(mapper.map(done, 5)).toEqual([
      { type: "tool.completed", runId: "run", ts: 5, toolCallId: "c1", name: "shell", output: "a\nb\n", isError: false, status: "success", input: { command: "ls", cwd: "/repo" } },
    ]);
  });

  it("reports failed tools as errors and diffs as file changes", () => {
    const mapper = new AcpUpdateMapper("run");
    mapper.map({ sessionUpdate: "tool_call", toolCallId: "e1", title: "src/a.ts", kind: "edit", status: "pending", rawInput: { filePath: "/repo/src/a.ts" } }, 1);
    const finished: SessionUpdate = {
      sessionUpdate: "tool_call_update",
      toolCallId: "e1",
      status: "completed",
      content: [{ type: "diff", path: "/repo/src/a.ts", oldText: "old", newText: "new" }],
      rawOutput: { output: "edited" },
    };
    expect(mapper.map(finished, 2).map((e) => e.type)).toEqual(["file.changed", "tool.completed"]);
    const failed = mapper.map({ sessionUpdate: "tool_call_update", toolCallId: "e2", status: "failed", kind: "read", rawOutput: { error: "no such file" } }, 3);
    expect(failed.map((e) => e.type)).toEqual(["tool.started", "tool.completed"]);
    expect(failed[1]).toMatchObject({ isError: true, status: "error", output: "no such file", name: "read" });
  });

  it("shows plans as one activity and folds context reports into the turn", () => {
    const mapper = new AcpUpdateMapper("run");
    const plan = mapper.map(
      {
        sessionUpdate: "plan",
        entries: [
          { content: "Read", priority: "high", status: "completed" },
          { content: "Write", priority: "medium", status: "pending" },
        ],
      },
      1,
    );
    expect(plan).toEqual([{ type: "activity.updated", runId: "run", ts: 1, activityId: "plan-plan", label: "Plan", status: "running", text: "[x] Read\n[ ] Write" }]);
    expect(mapper.map({ sessionUpdate: "usage_update", used: 1200, size: 200_000, cost: { amount: 0.01, currency: "USD" } }, 2)).toEqual([]);
    expect(mapper.endTurn(3).context).toEqual({ used: 1200, size: 200_000, costUsd: 0.01 });
  });
});
