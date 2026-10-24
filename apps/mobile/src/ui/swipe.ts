import { useRef } from "react";
import type { AccessibilityActionEvent } from "react-native";
import { haptic } from "./haptics";

/** A row's swipe action: what it says and does. Leading actions show from the left edge, trailing ones from the right. */
export interface SwipeAction {
  label: string;
  /** Unread in the review blue, as Mail's is blue; archiving in ink; forgetting in the bad tone. */
  tone: "accent" | "review" | "bad";
  run: () => void;
}

export type SwipeSide = "leading" | "trailing";

/** How far a row must travel, as a share of its width, for a swipe to do its action on release, as Mail does. */
export const FULL_SWIPE = 0.45;

/** The side a row moved this far (positive is right) has crossed into doing its action, if any. */
export function fullSwipe(translation: number, width: number): SwipeSide | null {
  "worklet";
  if (width <= 0 || Math.abs(translation) < width * FULL_SWIPE) return null;
  return translation > 0 ? "leading" : "trailing";
}

/** How wide a revealed action is before the swipe goes further. */
export const ACTION_WIDTH = 104;

/**
 * How a side's action draws while the row has moved this far (positive is right): it grows with a swipe toward it, so
 * a full swipe reads as filling the row, and hides during a swipe the other way, where it would paint over that side.
 */
export function actionLook(side: SwipeSide, translation: number): { width: number; opacity: number } {
  "worklet";
  const toward = side === "leading" ? translation : -translation;
  return { width: Math.max(ACTION_WIDTH, toward), opacity: toward < 0 ? 0 : 1 };
}

/** A row that can be closed, as the swipeable's own methods do. */
interface Closable {
  close(): void;
}

/**
 * The one row open on a swipe, as in Mail: opening another closes it, and so does a touch anywhere else on the screen
 * (a tap, a scroll, a fold). A touch inside the open row is its own: a tap on its action, or a swipe back.
 */
export function openSwipes() {
  let open: Closable | null = null;
  let inOpenRow = false;
  return {
    opened(row: Closable) {
      if (open && open !== row) open.close();
      open = row;
    },
    closed(row: Closable) {
      if (open === row) open = null;
    },
    /** A touch began in this row; the screen hears of the same touch next, as touches bubble. */
    touchedRow(row: Closable) {
      inOpenRow = open === row;
    },
    /** A touch began somewhere on the screen. */
    touched() {
      if (!inOpenRow) open?.close();
      inOpenRow = false;
    },
  };
}

export const swipes = openSwipes();

/**
 * The full swipe of a row with these actions: a light tap as the row crosses the threshold either way, and on release
 * past it, the action. A release short of it leaves the action showing, for a tap.
 */
export function useFullSwipe(actions: Partial<Record<SwipeSide, SwipeAction>>) {
  const armed = useRef<SwipeSide | null>(null);
  return {
    /** The row moved across the threshold, into a side or back out. */
    cross(side: SwipeSide | null) {
      if (side === armed.current) return;
      armed.current = side;
      if (side && actions[side]) haptic.tap();
    },
    /** The row was let go and settles open on `side`; true when the action ran, so the row should close. */
    release(side: SwipeSide): boolean {
      const ran = armed.current === side && actions[side] !== undefined;
      armed.current = null;
      if (ran) actions[side]!.run();
      return ran;
    },
  };
}

/** The same actions for VoiceOver, as the row's custom actions. */
export function swipeAccessibility(actions: readonly (SwipeAction | undefined)[]) {
  const listed = actions.filter((action): action is SwipeAction => action !== undefined);
  return {
    accessibilityActions: listed.map((action) => ({ name: action.label, label: action.label })),
    onAccessibilityAction: (event: AccessibilityActionEvent) => listed.find((action) => action.label === event.nativeEvent.actionName)?.run(),
  };
}
