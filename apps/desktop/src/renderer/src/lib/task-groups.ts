import type { TaskStatus } from "@openorc/protocol";
import { groupLabel, groupOrder } from "../components/status";
import { taskNeedsYou, taskRecordKey, type TaskRecord } from "./task-records";

export type TaskGroupKey = TaskStatus | "approval";
export type TaskGroup = { key: TaskGroupKey; label: string; tasks: TaskRecord[] };
export const waitingTaskGroups: readonly TaskGroupKey[] = ["approval", "review", "proposed"];
export const taskGroupOrder: readonly TaskStatus[] = ["review", "proposed", ...groupOrder.filter((status) => status !== "review" && status !== "proposed")];
export function taskGroups(tasks: readonly TaskRecord[]): TaskGroup[] {
  return [
    { key: "approval" as const, label: "Needs you", tasks: tasks.filter(taskNeedsYou) },
    ...taskGroupOrder.map((status) => ({ key: status, label: groupLabel[status], tasks: tasks.filter((record) => record.task.status === status && !taskNeedsYou(record)) })),
  ].filter((group) => group.tasks.length > 0);
}
/** Keep layout stable during interaction, while immediately dropping any record no longer readable. */
export function heldTaskGroups(groups: readonly TaskGroup[], records: readonly TaskRecord[]): TaskGroup[] {
  const current = new Map(records.map((record) => [taskRecordKey(record), record]));
  return groups.map((group) => ({ ...group, tasks: group.tasks.flatMap((record) => current.get(taskRecordKey(record)) ?? []) })).filter((group) => group.tasks.length > 0);
}
