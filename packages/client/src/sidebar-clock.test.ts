// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useSidebarNow } from "./sidebar-clock.js";
import { RECENT_MS, sidebarPlace } from "./sidebar-days.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("moves a thread out of Recent once its hours pass, with no new work to render the list again", () => {
  const now = new Date(2026, 10, 6, 20, 0).getTime();
  vi.useFakeTimers({ now });
  const at = now - RECENT_MS + 30_000;
  const { result } = renderHook(() => sidebarPlace(at, useSidebarNow()));
  expect(result.current).toBe("recent");
  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  expect(result.current).toBe("today");
});
