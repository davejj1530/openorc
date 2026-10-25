// @vitest-environment jsdom
import type { LegendListRef } from "@legendapp/list/react-native";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Row } from "./rows";
import { createFrameWindow, liveFrames, SETTLE_MS, useFramePlacement, WARM_UP_MS, type ListWindow } from "./visualization-window";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const view = { start: 10, end: 14, startBuffered: 6, endBuffered: 18 };

it("starts web views only on screen, nearest first, at most three", () => {
  const rows = [2, 7, 11, 13, 18, 25].map((index) => ({ key: `v${index}`, index }));
  expect([...liveFrames(rows, view)].sort()).toEqual(["v11", "v13"]);
  expect([...liveFrames(rows, view, new Set(), true)].sort()).toEqual(["v11", "v13"]);
  expect(liveFrames(rows, view, undefined, false, 1)).toEqual(new Set(["v11"]));
  const crowded = [10, 11, 12, 13].map((index) => ({ key: `v${index}`, index }));
  expect(liveFrames(crowded, view)).toEqual(new Set(["v10", "v11", "v12"]));
});

it("keeps a live frame while the list draws it, and past that while the list follows its end, if still in the transcript", () => {
  const rows = [
    { key: "far", index: 40 },
    { key: "drawn", index: 7 },
    { key: "near", index: 12 },
  ];
  const held = new Set(["far", "drawn", "gone"]);
  expect([...liveFrames(rows, view, held)]).toEqual(["near", "drawn"]);
  expect([...liveFrames(rows, view, held, true)]).toEqual(["near", "drawn", "far"]);
  const crowded = [7, 11, 13, 18, 40].map((index) => ({ key: `v${index}`, index }));
  expect(liveFrames(crowded, view, new Set(["v7", "v18", "v40"]), true)).toEqual(new Set(["v11", "v13", "v7"]));
});

it("tells only the rows whose frame came or went, and keeps what each frame last showed", () => {
  const frames = createFrameWindow();
  const heard = { a: vi.fn(), b: vi.fn(), c: vi.fn() };
  for (const [key, listener] of Object.entries(heard)) frames.subscribe(key, listener);
  frames.update(new Set(["a", "b"]));
  frames.update(new Set(["b", "c"]));
  expect([heard.a.mock.calls.length, heard.b.mock.calls.length, heard.c.mock.calls.length]).toEqual([2, 1, 1]);
  expect([frames.isLive("a"), frames.isLive("b"), frames.isLive("c")]).toEqual([false, true, true]);
  frames.keep("a", { kind: "page", height: 412 });
  frames.keep("b", { kind: "failed", message: "Bad step" });
  expect([frames.kept("a"), frames.kept("b"), frames.kept("c")]).toEqual([{ kind: "page", height: 412 }, { kind: "failed", message: "Bad step" }, undefined]);
  // A fresh page is asked for: one that failed loads again, one that drew keeps its height.
  frames.retry("a");
  frames.retry("b");
  expect([frames.kept("a"), frames.kept("b")]).toEqual([{ kind: "page", height: 412 }, undefined]);
  expect(createFrameWindow(true).isLive("anything")).toBe(true);
});

/** Rows with a visualization at each index given, the rest replies; and a list whose window and end a test moves. */
function transcript(...framed: number[]) {
  const rows = Array.from({ length: 30 }, (_, index): Row => {
    const key = `visualization:${index}`;
    return framed.includes(index) ? ({ kind: "visualization", key, gap: 14 } as Row) : ({ kind: "actions", key: `actions:${index}`, gap: 10, text: "" } as Row);
  });
  const list = { window: { start: 20, end: 26, startBuffered: 16, endBuffered: 29 } as ListWindow, isAtEnd: true };
  const listRef = { current: { getState: () => ({ ...list.window, isAtEnd: list.isAtEnd }) } as unknown as LegendListRef };
  return { rows, list, listRef };
}

it("brings frames in at once at the end and keeps them while the list follows, letting one go once the reader rests away from it", () => {
  const { rows, list, listRef } = transcript(22);
  const { result } = renderHook(() => useFramePlacement(rows, listRef, false));
  expect(result.current.frames.isLive("visualization:22")).toBe(true);
  // New rows land and the list's window passes over the frame for a moment.
  list.window = { start: 24, end: 29, startBuffered: 23, endBuffered: 29 };
  act(() => result.current.place());
  expect(result.current.frames.isLive("visualization:22")).toBe(true);
  act(() => void vi.advanceTimersByTime(SETTLE_MS));
  expect(result.current.frames.isLive("visualization:22")).toBe(true);
  // A reply streams in and the following list carries the frame away a line at a time: it stays while it follows.
  list.window = { start: 27, end: 29, startBuffered: 25, endBuffered: 29 };
  for (let line = 0; line < 5; line++) {
    act(() => result.current.place());
    act(() => void vi.advanceTimersByTime(600));
  }
  expect(result.current.frames.isLive("visualization:22")).toBe(true);
  // The reader scrolls past it: nothing changes while the list moves, and the frame goes once it rests.
  list.isAtEnd = false;
  list.window = { start: 2, end: 8, startBuffered: 0, endBuffered: 12 };
  act(() => result.current.placeAtRest());
  act(() => void vi.advanceTimersByTime(SETTLE_MS - 10));
  act(() => result.current.placeAtRest());
  act(() => void vi.advanceTimersByTime(SETTLE_MS - 10));
  expect(result.current.frames.isLive("visualization:22")).toBe(true);
  act(() => void vi.advanceTimersByTime(10));
  expect(result.current.frames.isLive("visualization:22")).toBe(false);
});

it("starts a frame the list draws off screen only once the reader brings it on screen and rests", () => {
  const { rows, list, listRef } = transcript(17);
  const { result } = renderHook(() => useFramePlacement(rows, listRef, false));
  expect(result.current.frames.isLive("visualization:17")).toBe(false);
  list.isAtEnd = false;
  list.window = { start: 15, end: 21, startBuffered: 11, endBuffered: 25 };
  act(() => result.current.placeAtRest());
  expect(result.current.frames.isLive("visualization:17")).toBe(false);
  act(() => void vi.advanceTimersByTime(SETTLE_MS));
  expect(result.current.frames.isLive("visualization:17")).toBe(true);
});

it("waits for rest before bringing in a frame an older page lands near the reader", () => {
  const first = transcript(3);
  first.list.isAtEnd = false;
  first.list.window = { start: 0, end: 6, startBuffered: 0, endBuffered: 10 };
  const { result, rerender } = renderHook(({ rows }) => useFramePlacement(rows, first.listRef, false), { initialProps: { rows: first.rows.slice(1) } });
  expect(result.current.frames.isLive("visualization:3")).toBe(false);
  rerender({ rows: first.rows });
  expect(result.current.frames.isLive("visualization:3")).toBe(false);
  act(() => void vi.advanceTimersByTime(SETTLE_MS));
  expect(result.current.frames.isLive("visualization:3")).toBe(true);
});

it("warms WebKit once the list has rested where a visualization may come, and not in a thread that has none", () => {
  const { rows, listRef } = transcript(22);
  const { result } = renderHook(() => useFramePlacement(rows, listRef, false));
  act(() => void vi.advanceTimersByTime(WARM_UP_MS - 10));
  expect(result.current.warm).toBe(false);
  // The reader moves: the warm-up waits for a full rest again.
  act(() => result.current.placeAtRest());
  act(() => void vi.advanceTimersByTime(WARM_UP_MS - 10));
  expect(result.current.warm).toBe(false);
  act(() => void vi.advanceTimersByTime(10));
  expect(result.current.warm).toBe(true);
  const plain = transcript();
  const { result: without } = renderHook(() => useFramePlacement(plain.rows, plain.listRef, false));
  act(() => void vi.advanceTimersByTime(60_000));
  expect(without.current.warm).toBe(false);
  // Older history not loaded yet may hold one.
  const { result: older } = renderHook(() => useFramePlacement(plain.rows, plain.listRef, true));
  act(() => void vi.advanceTimersByTime(WARM_UP_MS));
  expect(older.current.warm).toBe(true);
});
