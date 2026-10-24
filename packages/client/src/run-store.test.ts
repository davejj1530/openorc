import { beforeEach, expect, it, vi } from "vitest";
import type { AgentEvent } from "@openorc/protocol";
import { testClient } from "./test-fixtures/fake-connection.js";

const { client, call } = testClient();
const { runs } = client;
beforeEach(() => runs.reset());

it("restores an app declaration discovered after completion from the ledger", async () => {
  const mcp = { server: "screens", tool: "search", resourceUri: "ui://screens/gallery" };
  const events: AgentEvent[] = [
    { type: "tool.started", runId: "run", ts: 1, toolCallId: "call", name: "screens.search", input: {}, parentToolCallId: null, mcp: { server: "screens", tool: "search" } },
    { type: "tool.completed", runId: "run", ts: 2, toolCallId: "call", name: "screens.search", output: { content: [] }, isError: false },
    { type: "tool.updated", runId: "run", ts: 3, toolCallId: "call", mcp },
  ];
  runs.applyFrame({ runId: "run", seq: 1, events });
  expect(runs.get("run")?.blocks[0]).toMatchObject({ mcp, done: true });
  runs.reset();
  call.mockResolvedValueOnce({ events: JSON.parse(JSON.stringify(events)), fromTurn: 0, live: false });
  await runs.hydrate("run");
  expect(runs.get("run")?.blocks[0]).toMatchObject({ mcp, done: true, output: { content: [] } });
});

it("replays only what arrived after the listing, not streamed rows the ledger replaced meanwhile", async () => {
  const runId = "race";
  const delta = (messageId: string, text: string, eventId: string): AgentEvent => ({ type: "message.delta", runId, ts: 1, messageId, role: "assistant", text, eventId });
  const done: AgentEvent = { type: "message.completed", runId, ts: 2, messageId: "m1", role: "assistant", text: "hello", eventId: "e3" };
  let answer: (page: { events: AgentEvent[]; fromTurn: number; live: boolean }) => void = () => undefined;
  call.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
  const loading = runs.hydrate(runId);
  runs.applyFrame({ runId, seq: 1, events: [delta("m1", "hel", "e1"), delta("m1", "lo", "e2"), done, delta("m2", "next", "e4")] });
  // The completion replaced the second fragment in the ledger before the listing was read.
  answer({ events: [delta("m1", "hel", "e1"), done], fromTurn: 0, live: false });
  await loading;
  expect(runs.get(runId)?.blocks.map((block) => (block.kind === "message" ? [block.id, block.text, block.streaming] : block.id))).toEqual([
    ["m1", "hello", false],
    ["m2", "next", true],
  ]);
});

it("lets a run nothing shows leave memory a few minutes after its session ends, and keeps one a view holds", () => {
  vi.useFakeTimers();
  try {
    const start = (runId: string): AgentEvent[] => [
      { type: "session.started", runId, ts: 1, agent: "codex", externalSessionId: runId, model: "m" },
      { type: "message.delta", runId, ts: 2, messageId: "m", role: "assistant", text: "Working" },
    ];
    const end = (runId: string): AgentEvent => ({ type: "session.completed", runId, ts: 3, status: "success", durationMs: 2 });
    runs.applyFrame({ runId: "loose", seq: 1, events: start("loose") });
    runs.applyFrame({ runId: "held", seq: 1, events: start("held") });
    const release = runs.retain(["held"]);
    vi.advanceTimersByTime(4 * 60_000);
    expect(runs.get("loose")).toBeDefined();
    runs.applyFrame({ runId: "loose", seq: 2, events: [end("loose")] });
    runs.applyFrame({ runId: "held", seq: 2, events: [end("held")] });
    vi.advanceTimersByTime(4 * 60_000);
    expect(runs.get("loose")).toBeUndefined();
    expect(runs.get("held")).toBeDefined();
    release();
    vi.advanceTimersByTime(4 * 60_000);
    expect(runs.get("held")).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});
