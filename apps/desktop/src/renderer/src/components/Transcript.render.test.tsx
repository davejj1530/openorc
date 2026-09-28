import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentEvent } from "@openorc/protocol";
import { applyFrame, flushTranscripts, resetTranscripts, useRun } from "../lib/transcript";
import { WorkTranscript } from "./Transcript";

const counts = vi.hoisted(() => ({ messages: 0 }));
vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onFrame: vi.fn(), onInvalidate: vi.fn(), onReady: vi.fn() } }));
vi.mock("./AgentOrb", () => ({ AgentOrb: () => null }));
vi.mock("./TaskCard", () => ({ TaskCard: () => null }));
vi.mock("./QuestionCard", () => ({ QuestionCard: () => null }));
// Counts every render of an assistant message's rich text, the costly part of a row.
vi.mock("./ThreadImages", async (original) => {
  const real = await original<typeof import("./ThreadImages")>();
  return {
    ...real,
    ThreadRichText: (props: Parameters<typeof real.ThreadRichText>[0]) => {
      counts.messages += 1;
      return real.ThreadRichText(props);
    },
  };
});

/** A long conversation: finished turns with a tool call and a reply each, then a reply streaming in the live one. */
function history(runId: string, turns: number): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (let i = 0; i < turns; i++) {
    const ts = i * 100;
    events.push(
      { type: "message.completed", runId, ts, messageId: `ask-${i}`, role: "user", text: `Question ${i}` },
      { type: "tool.started", runId, ts: ts + 1, toolCallId: `read-${i}`, name: "Read", input: { file_path: `/src/${i}.ts` }, parentToolCallId: null },
      { type: "tool.completed", runId, ts: ts + 2, toolCallId: `read-${i}`, name: "Read", output: "contents", isError: false },
      { type: "message.completed", runId, ts: ts + 3, messageId: `reply-${i}`, role: "assistant", text: `Answer ${i}, with **some** detail.` },
      { type: "turn.completed", runId, ts: ts + 4, turnId: `turn-${i}`, status: "success", durationMs: 4 },
    );
  }
  events.push(
    { type: "message.completed", runId, ts: turns * 100, messageId: "ask-live", role: "user", text: "One more" },
    { type: "message.delta", runId, ts: turns * 100 + 1, messageId: "reply-live", role: "assistant", text: "Working" },
  );
  return events;
}

const word = (runId: string, text: string): AgentEvent => ({ type: "message.delta", runId, ts: Date.now(), messageId: "reply-live", role: "assistant", text });
const onFork = () => undefined;
function Conversation({ runId }: { runId: string }) {
  const run = useRun(runId);
  return run ? <WorkTranscript runId={runId} blocks={run.blocks} live onFork={onFork} /> : null;
}

beforeEach(() => {
  resetTranscripts();
  counts.messages = 0;
});
afterEach(cleanup);

it("re-renders only the streaming reply for each word, and nothing for another run's stream", () => {
  applyFrame({ runId: "big", seq: 1, events: history("big", 60) });
  applyFrame({ runId: "other", seq: 1, events: history("other", 2) });
  flushTranscripts();
  render(<Conversation runId="big" />);
  expect(counts.messages).toBe(61);

  for (const [seq, text] of [" on", " it", " now"].entries()) {
    counts.messages = 0;
    act(() => {
      applyFrame({ runId: "big", seq: seq + 2, events: [word("big", text)] });
      flushTranscripts();
    });
    expect(counts.messages).toBe(1);
  }

  counts.messages = 0;
  act(() => {
    applyFrame({ runId: "other", seq: 2, events: [word("other", " elsewhere")] });
    flushTranscripts();
  });
  expect(counts.messages).toBe(0);
});
