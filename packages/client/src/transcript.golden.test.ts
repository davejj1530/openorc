import { beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@openorc/protocol";
import type { Block, RunTranscript } from "./transcript.js";
import { testClient } from "./test-fixtures/fake-connection.js";
import { frameCuts, goldenStreams } from "./test-fixtures/transcript-streams.js";

const { client, call } = testClient();
const { runs } = client;
beforeEach(() => runs.reset());

/** Everything a view can read from a run, as plain data. */
function state(run: RunTranscript | undefined) {
  if (!run) return null;
  run.blocks.forEach((block, index) => expect(run.blockIndex.get(block.id)).toBe(index));
  expect(run.blockIndex.size).toBe(run.blocks.length);
  const { blocks, live, turnOpen, hydrated, fromTurn, eventCount, eventAt, turnsCompleted, pendingApprovals, stderr } = run;
  return { live, turnOpen, hydrated, fromTurn, eventCount, eventAt, turnsCompleted, pendingApprovals, stderr, turnOf: [...run.turnOf], blocks };
}

/** One line per block: enough to see what a frame changed without repeating every text. */
function outline(run: RunTranscript): string {
  const line = (block: Block): string => {
    switch (block.kind) {
      case "message":
        return `${block.text.length}${block.streaming ? "~" : ""}`;
      case "thinking":
        return `${block.text.length}${block.endedAt === null ? "~" : ""}${block.status ?? ""}`;
      case "tool":
        return `${typeof block.output === "string" ? block.output.length : typeof block.output}${block.done ? "" : "~"}${block.status ?? ""}${block.progress ? `:${block.progress}` : ""}`;
      case "activity":
        return `${block.status}:${block.text.length}`;
      case "approval":
        return block.decision ?? "?";
      case "status":
        return block.text;
    }
  };
  const flags = `${run.live ? "live" : "ended"} ${run.turnOpen ? "turn" : "idle"} ${run.pendingApprovals}`;
  return [flags, ...run.blocks.map((block) => `${block.id} ${block.kind} ${line(block)}`)].join(" | ");
}

function replay(events: AgentEvent[], frames: AgentEvent[][]): RunTranscript {
  const runId = events[0]!.runId;
  frames.forEach((frame, seq) => runs.applyFrame({ runId, seq, events: frame }));
  runs.flush();
  return runs.get(runId)!;
}

/** What the ledger hands back for a run: completed deltas folded away, long tool output left for the row to fetch. */
function ledgerPage(events: AgentEvent[]): AgentEvent[] {
  const completedMessages = new Set(events.flatMap((ev) => (ev.type === "message.completed" ? [ev.messageId] : [])));
  const completedTools = new Set(events.flatMap((ev) => (ev.type === "tool.completed" ? [ev.toolCallId] : [])));
  return events.flatMap((ev): AgentEvent[] => {
    if (ev.type === "message.delta" && completedMessages.has(ev.messageId)) return [];
    if (ev.type === "tool.output.delta" && completedTools.has(ev.toolCallId)) return [];
    if (ev.type === "tool.completed" && typeof ev.output === "string" && ev.output.length > 4096) {
      const { output: _omitted, ...rest } = ev;
      return [{ ...rest, output: undefined, outputOmitted: true }];
    }
    return [ev];
  });
}

describe("transcript golden replay", () => {
  for (const [name, events] of Object.entries(goldenStreams)) {
    it(`projects the ${name} stream the same however it is cut into frames`, () => {
      const results = Object.entries(frameCuts).map(([cut, frames]) => {
        runs.reset();
        return [cut, JSON.stringify(state(replay(events, frames(events))))] as const;
      });
      for (const [, result] of results) expect(result).toBe(results[0]![1]);
      expect(JSON.parse(results[0]![1])).toMatchSnapshot();
    });

    it(`publishes the same ${name} transcript after every frame`, () => {
      const runId = events[0]!.runId;
      const outlines = frameCuts.irregular!(events).map((frame, seq) => {
        runs.applyFrame({ runId, seq, events: frame });
        runs.flush();
        return outline(runs.get(runId)!);
      });
      expect(outlines).toMatchSnapshot();
    });
  }

  it("ignores a stream delivered twice", () => {
    const events = goldenStreams.claude!;
    const once = state(replay(events, frameCuts.irregular!(events)));
    runs.reset();
    const twice = state(replay(events, [...frameCuts.irregular!(events), ...frameCuts.single!(events)]));
    expect({ ...twice, eventCount: once?.eventCount }).toEqual(once);
    expect(twice?.eventCount).toBe(events.length * 2);
  });

  it("joins a ledger page with the frames that arrived while it loaded", async () => {
    const events = goldenStreams.codex!;
    const runId = events[0]!.runId;
    const listed = 120;
    let answer: (page: { events: AgentEvent[]; fromTurn: number; live: boolean }) => void = () => undefined;
    call.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const loading = runs.hydrate(runId, { turns: 4 });
    // Frames from before the listing was read, overlapping it, and after it.
    frameCuts.irregular!(events.slice(listed - 40, listed + 30)).forEach((frame, seq) => runs.applyFrame({ runId, seq, events: frame }));
    answer({ events: ledgerPage(events.slice(0, listed)), fromTurn: 0, live: true });
    await loading;
    frameCuts.irregular!(events.slice(listed + 30)).forEach((frame, seq) => runs.applyFrame({ runId, seq: seq + 100, events: frame }));
    runs.flush();
    expect(state(runs.get(runId))).toMatchSnapshot();
  });

  it("loads the newest turns, then older ones, keeping the blocks already shown", async () => {
    const events = goldenStreams.claude!;
    const runId = events[0]!.runId;
    const secondTurn = events.findIndex((ev) => ev.type === "turn.started" && ev.turnId === "t2");
    call.mockResolvedValueOnce({ events: ledgerPage(events.slice(secondTurn)), fromTurn: 1, live: true });
    await runs.hydrate(runId, { turns: 1 });
    const newest = runs.get(runId)!;
    const newestState = state(newest);
    call.mockResolvedValueOnce({ events: ledgerPage(events), fromTurn: 0, live: false });
    await runs.hydrate(runId, { fromTurn: 0 });
    const whole = runs.get(runId)!;
    for (const block of newest.blocks) {
      const index = whole.blockIndex.get(block.id);
      if (index !== undefined && JSON.stringify(whole.blocks[index]) === JSON.stringify(block)) expect(whole.blocks[index]).toBe(block);
    }
    expect({ newest: newestState, whole: state(whole) }).toMatchSnapshot();
  });
});
