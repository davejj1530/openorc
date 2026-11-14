import type { OnlineTaskRef } from "@openorc/protocol";
import type { TaskRecord } from "./task-records";
import { openTask, useRouter, type TaskTab } from "./router";

export function openOnlineTask(reference: OnlineTaskRef, tab: TaskTab = "spec"): void {
  const route = { view: "task", taskId: reference.id, tab, taskRef: reference } as const;
  useRouter.getState().navigate(route);
}
export function openTaskRecord(record: TaskRecord, tab?: TaskTab): void {
  if (record.kind === "online") openOnlineTask(record.reference, tab);
  else openTask(record.task.id, tab ?? (record.task.approval ? "chat" : "spec"));
}
