// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { newArrivals, useArrival } from "./arrivals";
import { emptyRowMemo, transcriptRows, type Row } from "./rows";
import { activity, finishedTurn, runStore } from "./test-fixtures/run-store";

const prompt = (id: string): Row => ({ kind: "prompt", key: `prompt:${id}`, gap: 24, block: { id, kind: "message", role: "user", text: id, streaming: false } });
const piece = (id: string, index: number): Row => ({ kind: "reply", key: `reply:${id}:${index}`, gap: 14, text: "", streaming: false, source: { runId: "r", blockId: id, index } });
const actions = (id: string): Row => ({ kind: "actions", key: `actions:${id}`, gap: 10, text: "" });
/** The agent's presence, which ends every transcript with a turn in it. */
const presence: Row = { kind: "presence", key: "presence", gap: 14, working: false };

describe("newArrivals", () => {
  it("lets each row arrive once, after the rows already known", () => {
    const known = new Set<string>();
    newArrivals([prompt("a"), piece("a", 0), presence], known);
    const rows = [prompt("a"), piece("a", 0), prompt("b"), piece("b", 0), presence];
    expect(newArrivals(rows, known)).toEqual(["prompt:b", "reply:b:0"]);
    expect(newArrivals(rows, known)).toEqual([]);
  });

  it("never lets an older page arrive: it lands above the rows already known", () => {
    const known = new Set<string>();
    newArrivals([prompt("b"), piece("b", 0), presence], known);
    expect(newArrivals([prompt("a"), piece("a", 0), prompt("b"), piece("b", 0), presence], known)).toEqual([]);
  });

  it("carries a streaming reply on into its next piece without a second arrival", () => {
    const known = new Set<string>();
    newArrivals([prompt("a"), piece("a", 0), presence], known);
    expect(newArrivals([prompt("a"), piece("a", 0), piece("a", 1), presence], known)).toEqual([]);
  });

  it("lets every piece of a reply that lands whole arrive, and leaves a finished turn's actions still", () => {
    const known = new Set<string>();
    newArrivals([prompt("a"), presence], known);
    expect(newArrivals([prompt("a"), piece("a", 0), piece("a", 1), actions("a"), presence], known)).toEqual(["reply:a:0", "reply:a:1"]);
  });

  it("lets a turn sent after the first page arrive, though the agent's presence stays below it", () => {
    const { frame } = runStore();
    const memo = emptyRowMemo();
    const known = new Set<string>();
    let run = frame(...finishedTurn);
    newArrivals(transcriptRows(run.blocks, activity(run), "r", memo), known);
    run = frame(
      { type: "turn.started", turnId: "t2" },
      { type: "message.completed", messageId: "ask-2", role: "user", text: "And the tests?" },
      { type: "message.delta", messageId: "reply-2", role: "assistant", text: "All pass" },
    );
    expect(newArrivals(transcriptRows(run.blocks, activity(run), "r", memo), known)).toEqual(["prompt:ask-2", expect.stringMatching(/^head:/), "reply:reply-2:0"]);
  });
});

describe("useArrival", () => {
  afterEach(cleanup);

  it("plays a row's arrival once: shown again in a recycled view or after a remount, it is simply there", () => {
    const arrivals = new Set(["reply:b:0"]);
    const view = renderHook(({ row }) => useArrival(row, arrivals), { initialProps: { row: "reply:b:0" } });
    expect(view.result.current).toBe(true);
    // The row updates while it rises (a word, a step): it keeps rising rather than remounting.
    view.rerender({ row: "reply:b:0" });
    expect(view.result.current).toBe(true);
    // The list hands the view to an older row, then back.
    view.rerender({ row: "prompt:a" });
    expect(view.result.current).toBe(false);
    view.rerender({ row: "reply:b:0" });
    expect(view.result.current).toBe(false);
    view.unmount();
    expect(renderHook(() => useArrival("reply:b:0", arrivals)).result.current).toBe(false);
  });
});
