// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { felt } from "../test-fixtures/haptics";
import { ACTION_WIDTH, actionLook, FULL_SWIPE, fullSwipe, openSwipes, swipeAccessibility, useFullSwipe, type SwipeAction } from "./swipe";

const action = (label: string): SwipeAction => ({ label, tone: "accent", run: vi.fn() });

it("does a side's action only once the row has travelled most of the way", () => {
  expect(fullSwipe(390 * FULL_SWIPE - 1, 390)).toBeNull();
  expect(fullSwipe(390 * FULL_SWIPE, 390)).toBe("leading");
  expect(fullSwipe(-390 * 0.9, 390)).toBe("trailing");
  expect(fullSwipe(200, 0)).toBeNull();
});

it("taps as the row crosses the threshold, and on release past it runs that side's action", () => {
  felt.length = 0;
  const unread = action("Unread");
  const archive = action("Archive");
  const { result } = renderHook(() => useFullSwipe({ leading: unread, trailing: archive }));
  result.current.cross("trailing");
  result.current.cross("trailing");
  expect(felt).toEqual(["impact light"]);
  expect(result.current.release("trailing")).toBe(true);
  expect(archive.run).toHaveBeenCalledOnce();
  expect(unread.run).not.toHaveBeenCalled();
});

it("leaves the action showing for a tap when the release falls short, or the row came back", () => {
  const unread = action("Unread");
  const { result } = renderHook(() => useFullSwipe({ leading: unread }));
  expect(result.current.release("leading")).toBe(false);
  result.current.cross("leading");
  result.current.cross(null);
  expect(result.current.release("leading")).toBe(false);
  result.current.cross("trailing");
  expect(result.current.release("trailing")).toBe(false);
  expect(unread.run).not.toHaveBeenCalled();
});

it("offers the same actions to VoiceOver", () => {
  const unread = action("Unread");
  const archive = action("Archive");
  const { accessibilityActions, onAccessibilityAction } = swipeAccessibility([unread, undefined, archive]);
  expect(accessibilityActions).toEqual([
    { name: "Unread", label: "Unread" },
    { name: "Archive", label: "Archive" },
  ]);
  onAccessibilityAction({ nativeEvent: { actionName: "Archive" } } as never);
  expect(archive.run).toHaveBeenCalledOnce();
});

it("grows only the side a full swipe moves toward, and hides the other so it cannot paint over it", () => {
  const right = 390 * 0.7;
  expect(actionLook("leading", right)).toEqual({ width: right, opacity: 1 });
  expect(actionLook("trailing", right)).toEqual({ width: ACTION_WIDTH, opacity: 0 });
  expect(actionLook("trailing", -right)).toEqual({ width: right, opacity: 1 });
  expect(actionLook("leading", -right)).toEqual({ width: ACTION_WIDTH, opacity: 0 });
  // At rest both keep their width, which the row measures as a swipe starts.
  expect(actionLook("leading", 0)).toEqual({ width: ACTION_WIDTH, opacity: 1 });
  expect(actionLook("trailing", 0)).toEqual({ width: ACTION_WIDTH, opacity: 1 });
});

it("closes the open row on a touch anywhere else, as Mail does, but not on a touch inside it", () => {
  const rows = openSwipes();
  const plan = { close: vi.fn() };
  const notes = { close: vi.fn() };
  rows.opened(plan);
  rows.touchedRow(plan);
  rows.touched();
  expect(plan.close).not.toHaveBeenCalled();
  rows.touchedRow(notes);
  rows.touched();
  expect(plan.close).toHaveBeenCalledOnce();
  rows.closed(plan);
  rows.touched();
  expect(plan.close).toHaveBeenCalledOnce();
});

it("closes the open row when another opens", () => {
  const rows = openSwipes();
  const plan = { close: vi.fn() };
  const notes = { close: vi.fn() };
  rows.opened(plan);
  rows.opened(notes);
  expect(plan.close).toHaveBeenCalledOnce();
  expect(notes.close).not.toHaveBeenCalled();
});
