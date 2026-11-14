import type { OnlineTasks } from "@openorc/hosted";
import type { OnlineTaskExecutionParams } from "@openorc/protocol";

/** Free preparation stays on the captured account service and never starts a local task. */
export function createOnlineTaskExecutionHandlers(tasks: Pick<OnlineTasks, "openThread"> | null) {
  return {
    "tasks.online.openThread": (input: OnlineTaskExecutionParams) => {
      if (!tasks) throw new Error("Online tasks aren't available here.");
      return tasks.openThread(input);
    },
  };
}
