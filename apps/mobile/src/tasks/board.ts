import { relativeTime } from "@openorc/client";
import type { BoardTask, TaskBoard, TaskStatus } from "@openorc/protocol";

/** A host the phone reads tasks from: the shown one (`host` null) or its partner, by its id here. */
export interface BoardHost {
  host: string | null;
  kind: "mac" | "brain";
  name: string;
  /** Its link is up now. */
  live: boolean;
  /** Its last answer; undefined until it gave one, or from a host before task lists. */
  board: TaskBoard | undefined;
  /** When the phone heard `board`, kept with it across launches. */
  heardAt: number;
}

/** A Mac's list as last heard while the Mac is out of reach: the phone's own, or its cloud brain's copy of it. */
export interface BoardCopy {
  at: number;
  /** The brain's copy, which keeps only the tasks of the Mac's projects in the cloud. */
  cloudOnly: boolean;
}

/** One host's open tasks, or the Mac's last list while it is out of reach (`copy` set). */
export interface BoardSection {
  key: string;
  title: string;
  /** The host a row opens its conversation on. */
  host: string | null;
  /** The host whose projects the rows name: a copy names the brain's copies of the Mac's projects. */
  namesOn: string | null;
  tasks: readonly BoardTask[];
  copy: BoardCopy | null;
}

export const boardStatus: Record<TaskStatus, string> = {
  proposed: "Proposed",
  backlog: "Backlog",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
  archived: "Archived",
};

/** Why a task from the brain's copy of the Mac's list does nothing here, said when the person presses it. */
export const MAC_NEEDED = "This task is on your Mac, which is asleep.";

/** The meta beside a copied section's title: how old the Mac's list is. */
export const copiedMeta = (at: number, now: number) => `As of ${relativeTime(at, now)}`;

/** Under a copied section's title when the copy is the brain's, which lacks the Mac's other projects. */
export const CLOUD_ONLY = "Only projects in the cloud";

/**
 * The task list's sections, the Mac first. A Mac's own answer counts as live only while its link is up; otherwise the
 * newest list of it stands in, read-only: the one the phone last heard, or its cloud brain's copy. A host that never
 * answered adds nothing.
 */
export function boardSections(hosts: readonly BoardHost[]): BoardSection[] {
  const mac = hosts.find((each) => each.kind === "mac");
  const brains = hosts.filter((each) => each.kind === "brain" && each.board);
  const sections: BoardSection[] = [];
  if (mac?.live && mac.board) sections.push({ key: "mac", title: mac.name, host: mac.host, namesOn: mac.host, tasks: mac.board.tasks, copy: null });
  else {
    const heard = mac?.board ? [{ tasks: mac.board.tasks, namesOn: mac.host, copy: { at: mac.heardAt, cloudOnly: false } }] : [];
    const copied = brains.flatMap(({ host, board }) => (board!.mac ? [{ tasks: board!.mac.tasks, namesOn: host, copy: { at: board!.mac.at, cloudOnly: true } }] : []));
    // On a tie the phone's own, which has every project.
    const newest = [...heard, ...copied].sort((a, b) => b.copy.at - a.copy.at)[0];
    if (newest) sections.push({ key: "mac-copy", title: mac?.name ?? "Mac", host: mac?.host ?? null, ...newest });
  }
  for (const brain of brains) sections.push({ key: `brain:${brain.host ?? ""}`, title: brain.name, host: brain.host, namesOn: brain.host, tasks: brain.board!.tasks, copy: null });
  return sections;
}

/** The conversation a task's row opens: the one doing its work, else the one that made it. */
export const taskThread = (task: BoardTask): string | null => task.executionThreadId ?? task.threadId;
