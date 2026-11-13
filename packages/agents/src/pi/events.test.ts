import { expect, it } from "vitest";
import { PiEvents, piUsage } from "./events.js";

it("lets a successful retry replace a transient error without ending the user's turn", () => {
  const mapper = new PiEvents("run");
  mapper.begin();
  mapper.map({ type: "message_start", message: { role: "assistant", content: [] } });
  mapper.map({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Overloaded" } });
  expect(mapper.error).toBe("Overloaded");
  expect(mapper.map({ type: "agent_end", willRetry: true })).toEqual([]);
  mapper.map({ type: "message_start", message: { role: "assistant", content: [] } });
  mapper.map({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Recovered" }], stopReason: "stop" } });
  expect(mapper.error).toBeNull();
  expect(mapper.text).toBe("Recovered");
  expect(mapper.map({ type: "agent_end", willRetry: false })).toEqual([]);
});

it("deduplicates tool output snapshots and retains the authoritative final result", () => {
  const mapper = new PiEvents("run");
  const tool = { toolCallId: "call", toolName: "bash" };
  const result = (text: string) => ({ content: [{ type: "text", text }] });
  expect(mapper.map({ type: "tool_execution_update", ...tool, partialResult: result("one") })[0]).toMatchObject({ type: "tool.output.delta", text: "one" });
  expect(mapper.map({ type: "tool_execution_update", ...tool, partialResult: result("one two") })[0]).toMatchObject({ type: "tool.output.delta", text: " two" });
  expect(mapper.map({ type: "tool_execution_update", ...tool, partialResult: result("one two") })).toEqual([]);
  expect(mapper.map({ type: "tool_execution_end", ...tool, result: result("one two three"), isError: false })[0]).toMatchObject({ type: "tool.completed", output: "one two three", isError: false });
});

it("does not invent context usage after compaction and keeps the session's cumulative cost", () => {
  expect(piUsage({ tokens: { input: 30, output: 10, cacheRead: 20, cacheWrite: 5 }, cost: 0.01, contextUsage: { tokens: null, contextWindow: 32000 } })).toEqual({
    inputTokens: 30,
    outputTokens: 10,
    cacheReadTokens: 20,
    cacheWriteTokens: 5,
    costUsd: 0.01,
  });
});
