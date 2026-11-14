import type { OnlineTasks } from "@openorc/hosted";
import type { OnlineTaskRpcResults, OnlineTaskParams } from "@openorc/protocol";
import { createOnlineTaskExecutionHandlers } from "./online-task-execution.js";

type OnlineTaskHandlers = { [M in keyof OnlineTaskRpcResults]: (input: OnlineTaskParams<M>) => Promise<OnlineTaskRpcResults[M]> | OnlineTaskRpcResults[M] };

/** Desktop-only methods bypass local task IDs, ownership routing, and phone projections. */
export function createOnlineTaskHandlers(tasks: OnlineTasks | null): OnlineTaskHandlers & ReturnType<typeof createOnlineTaskExecutionHandlers> {
  const service = (): OnlineTasks => {
    if (!tasks) throw new Error("Online tasks aren't available here.");
    return tasks;
  };
  return {
    ...createOnlineTaskExecutionHandlers(tasks),
    "tasks.online.state": (input) => tasks?.state(input) ?? { state: "unavailable" },
    "tasks.online.list": (input) => service().list(input),
    "tasks.online.get": (input) => service().get(input),
    "tasks.online.create": (input) => service().creation(input),
    "tasks.online.update": (input) => service().update(input),
    "tasks.online.delete": (input) => service().delete(input),
    "tasks.online.seen": (input) => service().seen(input),
    "tasks.online.attention": (input) => service().attention(input),
    "tasks.online.assignees": (input) => service().assignees(input),
    "tasks.online.activity": (input) => service().activity(input),
    "tasks.online.context": (input) => service().context(input),
  };
}
