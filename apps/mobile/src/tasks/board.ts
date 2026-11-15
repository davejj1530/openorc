import { relativeTime } from "@openorc/client";
import type { BoardTask, TaskBoard, TaskPriority, TaskStatus } from "@openorc/protocol";

/** The shown Mac as the task list reads it. */
export interface BoardMac {
  name: string;
  /** Its link is up now. */
  live: boolean;
  /** Its last answer; undefined until it gave one, or from a Mac before task lists. */
  board: TaskBoard | undefined;
  /** When the phone heard `board`, kept with it across launches. */
  heardAt: number;
}

/** The Mac's open tasks, or its last list while it is out of reach (`copiedAt` set). */
export interface BoardSection {
  key: string;
  title: string;
  tasks: readonly BoardTask[];
  /** When the phone heard the list, while the Mac is out of reach and the list is read-only; null for a live one. */
  copiedAt: number | null;
}

export const boardStatus: Record<TaskStatus, string> = {
  proposed: "Proposed",
  backlog: "Backlog",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
  archived: "Archived",
};

/** A group's heading may say more than its status's short name, as the desktop's task list does. */
export const boardGroup: Record<TaskStatus, string> = { ...boardStatus, review: "Ready for review" };

export const boardPriority: Record<TaskPriority, string> = { none: "No priority", low: "Low priority", medium: "Medium priority", high: "High priority", urgent: "Urgent" };

/** The desktop task list's group order: work under way first, then what waits on the person, then the rest. */
const GROUP_ORDER: readonly TaskStatus[] = ["in_progress", "review", "proposed", "backlog", "done", "archived"];

/** A host's tasks by status, in the list's group order, each group keeping the host's order; empty groups left out. */
export function boardGroups(tasks: readonly BoardTask[]): { status: TaskStatus; tasks: BoardTask[] }[] {
  return GROUP_ORDER.map((status) => ({ status, tasks: tasks.filter((task) => task.status === status) })).filter((group) => group.tasks.length > 0);
}

/** Why a task from the Mac's last list does nothing here, said when the person presses it. */
export const MAC_NEEDED = "This task is on your Mac, which is asleep.";

/** The meta beside a copied section's title: how old the Mac's list is. */
export const copiedMeta = (at: number, now: number) => `As of ${relativeTime(at, now)}`;

/**
 * The task list's section. The Mac's own answer counts as live only while its link is up; otherwise the list the phone
 * last heard stands in, read-only. A Mac that never answered has none.
 */
export function boardSection(mac: BoardMac | null): BoardSection | null {
  if (!mac?.board) return null;
  return mac.live ? { key: "mac", title: mac.name, tasks: mac.board.tasks, copiedAt: null } : { key: "mac-copy", title: mac.name, tasks: mac.board.tasks, copiedAt: mac.heardAt };
}

/** The conversation a task's row opens: the one doing its work, else the one that made it. */
export const taskThread = (task: BoardTask): string | null => task.executionThreadId ?? task.threadId;
