import type { Task, TaskStatus } from "@openorc/protocol";

type Counted = Pick<Task, "status" | "approval">;

/** How many tasks sit in one stage. */
export function stageCount(tasks: readonly Counted[], status: TaskStatus): number {
  return tasks.filter((task) => task.status === status).length;
}

/** Whether a task waits on the person: its run asks for an approval, an agent proposed it, or it is finished and in review. */
export function taskWaits(task: Counted): boolean {
  return Boolean(task.approval) || task.status === "proposed" || task.status === "review";
}

/** The sidebar's Tasks count: the tasks that wait on the person, each once. */
export function waitingTaskCount(tasks: readonly Counted[]): number {
  return tasks.filter(taskWaits).length;
}
