import { useCallback, useEffect, useState, type RefObject } from "react";
import type { TaskEvent } from "@openorc/protocol";
import { PANE_MS, swapInPlace } from "../../lib/motion";
import { taskRecordKey, type TaskRecord } from "../../lib/task-records";

/** The pane's id, which the card it belongs to names as what it opens. One pane is open in a window at a time. */
export const TASK_PANE_ID = "task-pane";

/** The pull request a task has: the one its agents last posted on its history. */
export function taskPullRequest(events: readonly TaskEvent[]): number | null {
  const posted = events.findLast((event) => event.kind === "update" && event.card?.kind === "pull_request");
  return posted?.kind === "update" && posted.card?.kind === "pull_request" ? posted.card.number : null;
}

/** Closing the pane from inside it hands the keyboard back to the card it belongs to. */
function focusOpenCard(): void {
  if (!document.getElementById(TASK_PANE_ID)?.contains(document.activeElement)) return;
  document.querySelector<HTMLElement>(`[aria-controls="${TASK_PANE_ID}"][aria-expanded="true"]`)?.focus();
}

/**
 * The task open beside the board, by its card's key: one kept on this computer or a team's, for as long as the board
 * holds it. Pressing its card again closes it, and pressing another swaps that one in where the pane stands.
 */
export function useOpenedTask(tasks: readonly TaskRecord[] | null) {
  const [id, setId] = useState<string | null>(null);
  const record = (id ? tasks?.find((each) => taskRecordKey(each) === id) : undefined) ?? null;
  useEffect(() => {
    if (id && !record) setId(null);
  }, [id, record]);
  const close = useCallback(() => {
    focusOpenCard();
    setId(null);
  }, []);
  return {
    record,
    /** The open task kept on this computer, whose project the screen's own controls follow. */
    task: record?.kind === "local" ? record.task : null,
    close,
    toggle(next: string) {
      if (next === id) setId(null);
      else if (record) swapInPlace("task-pane", () => setId(next));
      else setId(next);
    },
  };
}

/** A value while there is one, then the last one for as long as the pane takes to close, so the pane leaves with its content. */
export function useHeldThroughClose<T>(value: T | null): T | null {
  const [held, setHeld] = useState(value);
  useEffect(() => {
    if (value !== null) {
      setHeld(value);
      return;
    }
    const timer = setTimeout(() => setHeld(null), PANE_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return value ?? held;
}

/**
 * Escape closes the pane from the screen it stands on, or from nowhere in particular. A menu, a dialog or a list open
 * over the screen holds the keyboard outside it and takes its own Escape.
 */
export function useEscapeToClose(screen: RefObject<HTMLElement | null>, onClose: (() => void) | null): void {
  useEffect(() => {
    if (!onClose) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.target === document.body || (event.target instanceof Node && screen.current?.contains(event.target))) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [screen, onClose]);
}
