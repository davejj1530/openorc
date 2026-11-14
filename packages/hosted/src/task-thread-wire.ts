import { OnlineTaskThread } from "@openorc/protocol";
import { taskRequest } from "./task-requests.js";
import { wireOnlineTask } from "./wire-tasks.js";
import type { Route } from "./wire.js";

const reply = OnlineTaskThread.extend({ task: wireOnlineTask });
export function taskThreadRoute(id: string): Route<OnlineTaskThread> {
  return taskRequest({ method: "POST", path: `/tasks/${encodeURIComponent(id)}/open-thread`, reply });
}
