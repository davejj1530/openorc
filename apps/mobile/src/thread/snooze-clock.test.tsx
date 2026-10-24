// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fixtureThreads } from "../home/test-fixtures/threads";
import { useSnoozeClock } from "./snooze-clock";
import { threadMenu } from "./thread-actions";

const plan = fixtureThreads.find((thread) => thread.id === "t-plan")!;
const minutes = (count: number) => act(() => void vi.advanceTimersByTime(count * 60_000));

beforeEach(() => vi.useFakeTimers({ now: new Date(2026, 9, 21, 17) }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** A row's menu as the row builds it, counting each build. */
function rowMenu() {
  let builds = 0;
  const view = renderHook(() => {
    builds++;
    const snooze = threadMenu(plan, "row", useSnoozeClock())[0]!.find((action) => action.kind === "menu");
    return snooze?.kind === "menu" ? snooze.actions.map((action) => action.label) : [];
  });
  return { presets: () => view.result.current, builds: () => builds };
}

it("builds a row's menu again when its snooze presets change, so one built at five no longer offers This evening at half past six", () => {
  const menu = rowMenu();
  expect(menu.presets()).toContain("This evening");
  minutes(49);
  expect(menu.builds()).toBe(1);
  minutes(1);
  expect(menu.presets()).not.toContain("This evening");
  minutes(40);
  expect(menu.builds()).toBe(2);
  // Midnight brings the next evening back.
  minutes(6 * 60 + 30);
  expect(menu.presets()).toContain("This evening");
  expect(menu.builds()).toBe(3);
});

it("reads the time afresh for a row that shows after a while with no menu on screen", () => {
  rowMenu();
  cleanup();
  vi.setSystemTime(new Date(2026, 9, 21, 19));
  const later = rowMenu();
  expect(later.presets()).not.toContain("This evening");
  expect(later.builds()).toBe(1);
});
