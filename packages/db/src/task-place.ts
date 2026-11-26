import type { TaskActor, TaskStatus } from "@openorc/protocol";
import type { Db } from "./database.js";
import { taskEvents } from "./task-events.js";

type Place = { status: TaskStatus; column_id: string | null; column: string | null; position: number | null };
/** The part of a task's change that can move it. */
type Move = { status?: TaskStatus | undefined; columnId?: string | null | undefined };

/** Where a task sits: its status, and its board column with the name and the place the column has now. */
function placeOf(db: Db, id: string): Place | null {
  const row = db.stmt("SELECT t.status, t.column_id, c.name AS column, c.position FROM tasks t LEFT JOIN board_columns c ON c.id = t.column_id WHERE t.id = ?").get(id);
  return (row as Place | undefined) ?? null;
}

/**
 * Follows a task through a change that may move it. Called before the change, it answers with what to call after it,
 * which keeps a move in the task's history under whoever made it, the app when nobody is named. A move to a column
 * before the one the task left is marked as one back.
 */
export function trackingMove(db: Db, id: string, change: Move): (by?: TaskActor) => void {
  const before = change.status !== undefined || change.columnId !== undefined ? placeOf(db, id) : null;
  return (by = { kind: "app" }) => {
    const after = before ? placeOf(db, id) : null;
    if (!before || !after || (after.status === before.status && after.column_id === before.column_id)) return;
    const back = before.position !== null && after.position !== null && after.position < before.position;
    taskEvents.record(db, id, by, { kind: "moved", status: after.status, column: after.column, columnId: after.column_id, ...(back ? { back } : {}) });
  };
}

/**
 * For a status set without a column: the SET clause, and its argument, that takes the task out of a column whose stage
 * the status has left. SET reads the row as it was, so the clause compares the status before the change. A status
 * that is not explicit leaves alone a task whose status is.
 */
export function leavingColumn(change: Move, explicit: boolean): { set: string; arg: TaskStatus } | null {
  if (change.status === undefined || change.columnId !== undefined) return null;
  return { set: `column_id = CASE WHEN status = ?${explicit ? "" : " OR status_is_explicit = 1"} THEN column_id ELSE NULL END`, arg: change.status };
}
