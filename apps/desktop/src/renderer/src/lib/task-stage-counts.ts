import type { TaskStatus } from "@openorc/protocol";

type Counted = { status: TaskStatus };

/** How many tasks sit in one stage. */
export function stageCount(tasks: readonly Counted[], status: TaskStatus): number {
  return tasks.filter((task) => task.status === status).length;
}

/** The sidebar's Tasks count: the tasks that wait on the person, proposed by an agent or finished and in review. */
export function waitingTaskCount(tasks: readonly Counted[]): number {
  return stageCount(tasks, "proposed") + stageCount(tasks, "review");
}
