// @vitest-environment jsdom
import type { RpcMethod } from "@openorc/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { useMentionOpening, useNoteReading } from "./thread-notes";

/** A Mac that records each mark, and refuses the next one when a test says so. */
const mac = vi.hoisted(() => ({ phone: null as FakeMac | null, reads: [] as string[][], refuse: false }));
vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac((method: RpcMethod, params) => {
    if (method !== "threads.readNotes") return Promise.resolve(null);
    mac.reads.push((params as { ids: string[] }).ids);
    if (!mac.refuse) return Promise.resolve(null);
    mac.refuse = false;
    return Promise.reject(new Error("OpenOrc Cloud can't be reached."));
  });
  return mac.phone.module;
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  mac.reads = [];
});

const reading = () => renderHook(() => useNoteReading("t1"), { wrapper: mac.phone!.wrapper }).result.current;

it("marks the notes seen together in one call, and each note once", async () => {
  const seen = reading();
  seen(["n1", "n2"]);
  seen(["n2", "n3"]);
  await act(() => vi.advanceTimersByTimeAsync(400));
  seen(["n1"]);
  await act(() => vi.advanceTimersByTimeAsync(400));
  expect(mac.reads).toEqual([["n1", "n2", "n3"]]);
});

it("marks a note again the next time it is seen after its mark failed", async () => {
  mac.refuse = true;
  const seen = reading();
  seen(["n1"]);
  await act(() => vi.advanceTimersByTimeAsync(400));
  seen(["n1"]);
  await act(() => vi.advanceTimersByTimeAsync(400));
  expect(mac.reads).toEqual([["n1"], ["n1"]]);
});

it("marks at most a hundred in one call, the rest in the next", async () => {
  const seen = reading();
  seen(Array.from({ length: 130 }, (_, index) => `n${index}`));
  await act(() => vi.advanceTimersByTimeAsync(800));
  expect(mac.reads.map((ids) => ids.length)).toEqual([100, 30]);
});

it("opens at the first unread mention the thread had as it opened, however it changes after", () => {
  const thread = (firstUnreadNoteId: string | null) =>
    ({ id: "t1", owner: { brain: "hosted", reach: "live", heardAt: 0, collaboration: { mentions: { unread: firstUnreadNoteId !== null, firstUnreadNoteId } } } }) as never;
  const { result, rerender } = renderHook(({ id }) => useMentionOpening(thread(id)), { initialProps: { id: "n4" as string | null } });
  expect(result.current).toBe("n4");
  rerender({ id: "n9" });
  expect(result.current).toBe("n4");
  rerender({ id: null });
  expect(result.current).toBe("n4");
});
