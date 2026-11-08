import { describe, expect, it } from "vitest";
import { OmpJsonParser } from "./json-events.js";

const lines = [
  { type: "session", version: 3, id: "01a1bafa-0862-741a-8ba2-fdc2d2690b86", timestamp: "2026-11-08T11:45:10.754Z", cwd: "/work" },
  { type: "agent_start" },
  { type: "message_end", message: { role: "user", content: "Carry on" } },
  { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Look" } },
  {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hm" },
        { type: "text", text: "Looking at the tests." },
      ],
      stopReason: "toolUse",
    },
  },
  { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "pnpm test" } },
  { type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: { content: [{ type: "text", text: "2 passed" }], details: {} }, isError: false },
  { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "All green." }], stopReason: "stop" } },
  { type: "agent_settled", aborted: false },
].map((line) => JSON.stringify(line));

describe("Oh My Pi's JSON events", () => {
  it("reads one headless turn: its session, replies and tool calls", () => {
    const parser = new OmpJsonParser("run-1");
    const events = lines.flatMap((line) => parser.parseLine(line, 10));
    expect(parser.parseLine("not json", 10)).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(["session.started", "turn.started", "message.completed", "tool.started", "tool.completed", "message.completed"]);
    expect(events[0]).toMatchObject({ agent: "omp", externalSessionId: "01a1bafa-0862-741a-8ba2-fdc2d2690b86" });
    expect(events[4]).toMatchObject({ toolCallId: "call-1", output: "2 passed", isError: false, status: "success" });
    expect(parser.end(0, 50)).toEqual([{ type: "turn.completed", runId: "run-1", ts: 50, turnId: "turn-1", status: "success", resultText: "All green.", durationMs: 40 }]);
    expect(parser.turns).toBe(1);
  });

  it("ends a turn whose model failed as an error, saying why", () => {
    const parser = new OmpJsonParser("run-2");
    parser.parseLine(lines[0]!, 1);
    const failed = parser.parseLine(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "401 Unauthorized" } }), 2);
    expect(failed).toEqual([{ type: "error", runId: "run-2", ts: 2, message: "401 Unauthorized", fatal: false }]);
    expect(parser.end(0, 3)[0]).toMatchObject({ status: "error" });
  });

  it("closes nothing when the process never started a session", () => {
    expect(new OmpJsonParser("run-3").end(1)).toEqual([]);
  });
});
