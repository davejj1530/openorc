// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { AgentEvent, Run } from "@openorc/protocol";
import { afterEach, expect, it } from "vitest";
import { testClient } from "./test-fixtures/fake-connection.js";

const { client, call, push, wrapper } = testClient();

/** A run's ledger: `turns` finished turns of one prompt and one reply each. */
function ledger(runId: string, turns: number, start: number): AgentEvent[][] {
  return Array.from({ length: turns }, (_, turn) => {
    const at = start + turn * 10;
    const event = (index: number, draft: object) => ({ runId, ts: at + index, eventId: `${runId}-${turn}-${index}`, ...draft }) as AgentEvent;
    return [
      event(0, { type: "turn.started", turnId: `${runId}-t${turn}` }),
      event(1, { type: "message.completed", messageId: `${runId}-ask-${turn}`, role: "user", text: `ask ${turn}` }),
      event(2, { type: "message.completed", messageId: `${runId}-reply-${turn}`, role: "assistant", text: `reply ${turn}` }),
      event(3, { type: "turn.completed", turnId: `${runId}-t${turn}`, status: "success", durationMs: 5 }),
    ];
  });
}

const run = (id: string) => ({ id, threadId: "t", agent: "codex", model: "m", mode: "act", permissionMode: "trusted" }) as unknown as Run;
const pages = new Map<string, AgentEvent[][]>([
  ["older", ledger("older", 2, 1_000)],
  ["newer", ledger("newer", 6, 2_000)],
]);

function serve() {
  call.mockImplementation(async (method, params) => {
    if (method === "threads.messages") return [];
    if (method !== "events.page") throw new Error(`unexpected ${method}`);
    const { runId, turns, fromTurn } = params as { runId: string; turns?: number; fromTurn?: number };
    const all = pages.get(runId)!;
    const from = turns !== undefined ? Math.max(0, all.length - turns) : (fromTurn ?? 0);
    return { events: all.slice(from).flat(), fromTurn: from, live: false };
  });
}

afterEach(() => {
  cleanup();
  client.runs.reset();
  client.queryClient.clear();
  call.mockReset();
});

const replies = (blocks: { kind: string; role?: string; text?: string }[] | undefined) =>
  (blocks ?? []).filter((block) => block.kind === "message" && block.role === "assistant").map((block) => block.text);
const pageRequests = () => call.mock.calls.filter(([method]) => method === "events.page").map(([, params]) => params);

it("opens on the newest run's last four turns, then pages four at a time, then into the run before", async () => {
  serve();
  const { result } = renderHook(() => client.useConversationTranscript({ runs: [run("older"), run("newer")], threadId: "t" }), { wrapper });
  await waitFor(() => expect(replies(result.current.merged?.blocks)).toEqual(["reply 2", "reply 3", "reply 4", "reply 5"]));
  expect(result.current.hasOlder).toBe(true);

  act(() => result.current.loadOlder());
  await waitFor(() => expect(replies(result.current.merged?.blocks)).toEqual(["reply 0", "reply 1", "reply 2", "reply 3", "reply 4", "reply 5"]));
  expect(result.current.hasOlder).toBe(true);

  act(() => result.current.loadOlder());
  await waitFor(() => expect(replies(result.current.merged?.blocks)).toEqual(["reply 0", "reply 1", "reply 0", "reply 1", "reply 2", "reply 3", "reply 4", "reply 5"]));
  expect(result.current.hasOlder).toBe(false);
  expect(pageRequests()).toEqual([
    { runId: "newer", turns: 4 },
    { runId: "newer", fromTurn: 0 },
    { runId: "older", turns: 4 },
  ]);
});

it("opens at a target in an earlier run: that run from the turn before the target's, every later run whole", async () => {
  serve();
  const target = { runId: "older", turn: 1 };
  const { result } = renderHook(() => client.useConversationTranscript({ runs: [run("older"), run("newer")], threadId: "t", target }), { wrapper });
  await waitFor(() => expect(replies(result.current.merged?.blocks)).toEqual(["reply 0", "reply 1", "reply 0", "reply 1", "reply 2", "reply 3", "reply 4", "reply 5"]));
  expect(result.current.hasOlder).toBe(false);
  expect(pageRequests()).toEqual(
    expect.arrayContaining([
      { runId: "older", fromTurn: 0 },
      { runId: "newer", fromTurn: 0 },
    ]),
  );
  expect(pageRequests()).not.toContainEqual({ runId: "older", turns: 4 });
});

it("opens at a target in the newest run from the turn before it, further back than the first page", async () => {
  serve();
  const target = { runId: "newer", turn: 2 };
  const { result } = renderHook(() => client.useConversationTranscript({ runs: [run("older"), run("newer")], threadId: "t", target }), { wrapper });
  await waitFor(() => expect(replies(result.current.merged?.blocks)).toEqual(["reply 1", "reply 2", "reply 3", "reply 4", "reply 5"]));
  expect(result.current.hasOlder).toBe(true);
});

it("names the newest run's transcript as the live one, and the whole conversation after the active run", async () => {
  serve();
  const { result } = renderHook(() => client.useConversationTranscript({ runs: [run("newer")], threadId: "t" }), { wrapper });
  await waitFor(() => expect(result.current.liveTranscript?.runId).toBe("newer"));
  expect(result.current.merged?.runId).toBe("newer");
  expect(result.current.transcripts.map((transcript) => transcript?.runId)).toEqual(["newer"]);
});

it("places the thread's own messages among the turns by time, and keeps the turns in their order", async () => {
  serve();
  const served = call.getMockImplementation()!;
  call.mockImplementation(async (method, params) =>
    method === "threads.messages" ? [{ id: "note", role: "system", text: "Handed over", createdAt: 2_025, attachments: [] }] : served(method, params),
  );
  const { result } = renderHook(() => client.useConversationTranscript({ runs: [run("newer")], threadId: "t" }), { wrapper });
  const texts = () => (result.current.merged?.blocks ?? []).filter((block) => block.kind === "message").map((block) => (block.kind === "message" ? block.text : ""));
  await waitFor(() => expect(texts()).toContain("Handed over"));
  expect(texts()).toEqual(["ask 2", "reply 2", "Handed over", "ask 3", "reply 3", "ask 4", "reply 4", "ask 5", "reply 5"]);
});

/** Serves the ledger, except that the first page asked for is lost on the way. */
function dropFirstPage() {
  serve();
  const answer = call.getMockImplementation()!;
  let dropped = false;
  call.mockImplementation(async (method, params) => {
    if (method !== "events.page" || dropped) return answer(method, params);
    dropped = true;
    throw new Error("dropped");
  });
}

it.each([
  ["one run", [run("newer")]],
  ["two runs", [run("older"), run("newer")]],
])("loads a run again after a resumed session when its first page failed, with %s", async (_, runs) => {
  dropFirstPage();
  const { result } = renderHook(() => client.useConversationTranscript({ runs, threadId: "t" }), { wrapper });
  await waitFor(() => expect(pageRequests()).toHaveLength(1));
  await act(async () => push({ type: "session", resumed: true }));
  await waitFor(() => expect(replies(result.current.merged?.blocks)).toEqual(["reply 2", "reply 3", "reply 4", "reply 5"]));
  expect(pageRequests()).toHaveLength(2);
});

it("loads a run again when the thread opens again after its first page failed", async () => {
  dropFirstPage();
  const open = () => renderHook(() => client.useConversationTranscript({ runs: [run("newer")], threadId: "t" }), { wrapper });
  open().unmount();
  await waitFor(() => expect(pageRequests()).toHaveLength(1));
  const { result } = open();
  await waitFor(() => expect(replies(result.current.merged?.blocks)).toEqual(["reply 2", "reply 3", "reply 4", "reply 5"]));
  expect(pageRequests()).toHaveLength(2);
});
