// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ANSWER_WITHIN_MS, queueAnswer, takeQueued, useQueuedAnswer } from "./answers";

const a1 = { macId: "studio", runId: "r1", approvalId: "a1" };

beforeEach(() => void vi.useFakeTimers({ now: 10_000 }));
afterEach(() => {
  cleanup();
  // Every answer left has waited too long by then, so the next test starts with none queued.
  takeQueued(a1, Date.now() + 2 * ANSWER_WITHIN_MS);
  vi.useRealTimers();
});

it("shows an answer chosen on an alert to its card until the card takes it, once", () => {
  queueAnswer(a1, "deny", Date.now());
  expect(renderHook(() => useQueuedAnswer(a1)).result.current).toBe("deny");
  expect(renderHook(() => useQueuedAnswer(a1)).result.current).toBe("deny");
  expect(takeQueued(a1, Date.now())).toBe("deny");
  expect(takeQueued(a1, Date.now())).toBeNull();
  expect(renderHook(() => useQueuedAnswer(a1)).result.current).toBeNull();
  expect(renderHook(() => useQueuedAnswer({ ...a1, approvalId: "a2" })).result.current).toBeNull();
});

it("keeps an answer for its own run and Mac, since approval ids repeat across runs and Macs", () => {
  queueAnswer(a1, "allow", Date.now());
  expect(renderHook(() => useQueuedAnswer({ ...a1, runId: "r2" })).result.current).toBeNull();
  expect(renderHook(() => useQueuedAnswer({ ...a1, macId: "laptop" })).result.current).toBeNull();
  expect(renderHook(() => useQueuedAnswer(null)).result.current).toBeNull();
  expect(renderHook(() => useQueuedAnswer(a1)).result.current).toBe("allow");
});

it("lets an answer go once the thread has not loaded for 2 minutes", () => {
  queueAnswer(a1, "allow", Date.now());
  vi.setSystemTime(Date.now() + ANSWER_WITHIN_MS + 1);
  expect(renderHook(() => useQueuedAnswer(a1)).result.current).toBeNull();
  expect(ANSWER_WITHIN_MS).toBe(120_000);
});

it("reaches a card already on screen", () => {
  const card = renderHook(() => useQueuedAnswer(a1));
  expect(card.result.current).toBeNull();
  act(() => queueAnswer(a1, "allow", Date.now()));
  expect(card.result.current).toBe("allow");
});
