import type { OnlineTask, OnlineTaskRpcResults } from "@openorc/protocol";
import { shownTaskActivity } from "./task-activity-shown";

const active = (task: OnlineTask) => task.viewer.liveExecution || shownTaskActivity(task.activity, Date.now())?.state === "working";

/** Hidden windows keep the query library's default pause; visible running work refreshes between socket notices. */
export function taskRefreshInterval(data: OnlineTaskRpcResults[keyof OnlineTaskRpcResults] | undefined): number {
  if (!data) return 30_000;
  const single = "task" in data && active(data.task);
  const many = "tasks" in data && data.tasks.some(active);
  return single || many ? 3_000 : 30_000;
}
