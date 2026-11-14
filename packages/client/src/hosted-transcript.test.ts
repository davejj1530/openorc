// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Run } from "@openorc/protocol";
import { testClient } from "./test-fixtures/fake-connection.js";
import { applyEvents, emptyRun } from "./transcript.js";

const { client, call, wrapper } = testClient();
afterEach(() => {
  cleanup();
  client.runs.reset();
  client.queryClient.clear();
  call.mockReset();
});

it("does not request unsupported message history while a cloud thread's runs are loading", async () => {
  renderHook(() => client.useConversationTranscript({ runs: [], threadId: "example", hosted: true }), { wrapper });
  await Promise.resolve();
  expect(call).not.toHaveBeenCalled();
});

it("takes a cloud conversation's messages from its event page without asking for a second message history", async () => {
  call.mockImplementation(async (method) => {
    if (method === "events.page")
      return { events: [{ runId: "hosted:example", type: "message.completed", ts: 1, messageId: "reply", role: "assistant", text: "Saved reply" }], fromTurn: 0, live: false };
    throw new Error(`Unexpected ${method}`);
  });
  const run = { id: "hosted:example", threadId: "example", agent: "codex", model: "example", mode: "act", permissionMode: "trusted" } as Run;
  const { result } = renderHook(() => client.useConversationTranscript({ runs: [run], threadId: "example" }), { wrapper });
  await waitFor(() => expect(result.current.merged?.blocks.some((block) => block.kind === "message" && block.text === "Saved reply")).toBe(true));
  expect(call.mock.calls.some(([method]) => method === "threads.messages")).toBe(false);
});

it("keeps actual hosted context facts without changing the local projection", () => {
  const cloud = emptyRun("hosted:example");
  const local = emptyRun("local");
  for (const run of [cloud, local]) applyEvents(run, [{ type: "context.updated", runId: run.runId, ts: 2, contextTokens: 1500, contextWindow: 10000 }]);
  expect(cloud).toMatchObject({ context: { used: 1500, window: 10000 } });
  expect(local).not.toHaveProperty("context");
});

it("does not turn cumulative usage into a context estimate", () => {
  const run = emptyRun("hosted:example");
  applyEvents(run, [{ type: "usage.updated", runId: run.runId, ts: 2, usage: { inputTokens: 120000, outputTokens: 4000 } }]);
  expect(run.context).toBeUndefined();
  applyEvents(run, [{ type: "usage.updated", runId: run.runId, ts: 3, usage: { inputTokens: 121000, outputTokens: 4100, contextTokens: 1600 } }]);
  expect(run.context).toEqual({ used: 1600, window: null });
});
