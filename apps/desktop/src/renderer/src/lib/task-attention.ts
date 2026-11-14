import type { OnlineTask, Task } from "@openorc/protocol";
import { waitingTaskCount } from "./task-stage-counts";

/** Each online task contributes once, regardless of how many reasons the server returned. */
export function onlineAttentionCount(tasks: readonly OnlineTask[]): number {
  return new Set(tasks.filter((task) => task.viewer.attention.length > 0).map((task) => JSON.stringify([task.spaceId, task.id]))).size;
}
/** Local attention retains its existing predicate; the server supplies the exact accessible online count. */
export function composedTaskAttention(local: readonly Task[], onlineCount: number): number {
  return waitingTaskCount(local) + onlineCount;
}
