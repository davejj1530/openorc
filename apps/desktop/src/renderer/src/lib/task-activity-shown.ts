import { useEffect, useReducer } from "react";
import type { OnlineTask } from "@openorc/protocol";

type Activity = OnlineTask["activity"];

/**
 * How long a task whose turn just finished still reads as working. An agent often ends its turn and carries on in a turn
 * of its own a few seconds later, and the task should not flicker to finished and back between them.
 */
export const CARRY_ON_MS = 15_000;

/** The task's activity as a person should read it at `now`. */
export function shownTaskActivity(activity: Activity, now: number): Activity {
  return activity?.state === "completed" && now - activity.updatedAt < CARRY_ON_MS ? { ...activity, state: "working" } : activity;
}

/** The same, drawn again once a just-finished turn's moment has passed. */
export function useShownTaskActivity(activity: Activity): Activity {
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  const settles = activity?.state === "completed" ? activity.updatedAt + CARRY_ON_MS : null;
  useEffect(() => {
    const wait = settles === null ? 0 : settles - Date.now();
    if (wait <= 0) return;
    const timer = setTimeout(redraw, wait);
    return () => clearTimeout(timer);
  }, [settles]);
  return shownTaskActivity(activity, Date.now());
}
