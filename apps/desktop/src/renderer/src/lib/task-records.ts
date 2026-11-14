import type { OnlineTask, OnlineTaskRef, Project, SpaceProject, Task } from "@openorc/protocol";

export type TaskRecord = { kind: "local"; task: Task } | { kind: "online"; task: OnlineTask; reference: OnlineTaskRef; project: Project | undefined };
export const localTaskRecord = (task: Task): TaskRecord => ({ kind: "local", task });
export function onlineTaskRecord(task: OnlineTask, accountId: string, projects: readonly SpaceProject[], presentations: readonly Project[]): TaskRecord {
  const project = projects.find((row) => row.hostedProjectId === task.projectId);
  return {
    kind: "online",
    task,
    reference: { kind: "online", id: task.id, accountId, spaceId: task.spaceId, projectId: task.projectId },
    project: presentations.find((row) => row.id === project?.key),
  };
}
export const taskRecordKey = (record: TaskRecord): string =>
  record.kind === "local" ? `local:${record.task.id}` : JSON.stringify([record.reference.accountId, record.reference.spaceId, record.task.id]);
export const taskNeedsYou = (record: TaskRecord): boolean => (record.kind === "local" ? Boolean(record.task.approval) : record.task.viewer.attention.includes("ask"));
export const taskNeedsAttention = (record: TaskRecord): boolean =>
  record.kind === "online" ? record.task.viewer.attention.length > 0 : taskNeedsYou(record) || record.task.status === "review" || record.task.status === "proposed";
