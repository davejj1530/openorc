import type { BoardColumn, Task, TaskStatus } from "@openorc/protocol";
import { boardStatus } from "./board";
import type { TaskPatch } from "./task-edit";

/** The desktop's menu order (components/status.tsx). */
const STATUS_ORDER: readonly TaskStatus[] = ["proposed", "backlog", "in_progress", "review", "done", "archived"];

/** One entry of a task's Status menu: a column of its project's board, or a status no column stands for. */
export interface TaskPlace {
  /** The column's id, or the status. */
  key: string;
  name: string;
  /** The status of a task that stands here: the column's stage. */
  status: TaskStatus;
  columnId: string | null;
}

const statusPlace = (status: TaskStatus): TaskPlace => ({ key: status, name: boardStatus[status], status, columnId: null });

/**
 * The Status menu's entries: the project's columns in the board's order, and each status no column stands for (a
 * proposal and the archive always, a stage the board dropped) before the first column of a later one, as the desktop's
 * board places them. A project that keeps no columns, or an older Mac's, has the statuses.
 */
export function taskPlaces(columns: readonly Pick<BoardColumn, "id" | "name" | "stage">[]): TaskPlace[] {
  const places: TaskPlace[] = columns.map((column) => ({ key: column.id, name: column.name, status: column.stage, columnId: column.id }));
  for (const status of STATUS_ORDER) {
    if (places.some((place) => place.status === status)) continue;
    const later = places.findIndex((place) => STATUS_ORDER.indexOf(place.status) > STATUS_ORDER.indexOf(status));
    places.splice(later < 0 ? places.length : later, 0, statusPlace(status));
  }
  return places;
}

/** Where a task stands: the column it was put in, else the first column of its status, as the board draws it. */
export function taskPlace(task: Pick<Task, "status" | "columnId">, places: readonly TaskPlace[]): TaskPlace {
  const own = task.columnId ? places.find((place) => place.columnId === task.columnId) : undefined;
  return own ?? places.find((place) => place.status === task.status) ?? statusPlace(task.status);
}

/** What moving a task to `place` saves: the column by its id, which gives the task its stage on the Mac, or the status. */
export const placePatch = (place: TaskPlace): TaskPatch => (place.columnId === null ? { status: place.status } : { columnId: place.columnId });

/** How a task reads once it stands at `place`, shown until the Mac answers. */
export const placedAt = (place: TaskPlace): Pick<Task, "status" | "columnId"> => ({ status: place.status, columnId: place.columnId });
