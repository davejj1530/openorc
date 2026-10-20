import type { TaskStatus } from "@openorc/protocol";

type Counted = { status: TaskStatus };

/** How many tasks sit in one stage. */
export function stageCount(tasks: readonly Counted[], status: TaskStatus): number {
  return tasks.filter((task) => task.status === status).length;
}

/** The stages that still ask for attention: proposed, in progress and in review. */
const OPEN_STAGES: readonly TaskStatus[] = ["proposed", "in_progress", "review"];

/** The sidebar's Tasks count: everything proposed, in progress or in review. */
export function openTaskCount(tasks: readonly Counted[]): number {
  return OPEN_STAGES.reduce((sum, status) => sum + stageCount(tasks, status), 0);
}

/** The sidebar's Schedules count: the schedules that are switched on. */
export function activeScheduleCount(schedules: readonly { enabled: boolean }[]): number {
  return schedules.filter((schedule) => schedule.enabled).length;
}
