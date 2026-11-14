import { hostedThreadOf, type RoutedMethod } from "@openorc/protocol";
import { Refused } from "./session.js";
import type { Threads } from "./threads.js";

const writes = new Set<RoutedMethod>([
  "runs.start",
  "runs.send",
  "runs.interrupt",
  "threads.queue",
  "threads.unqueue",
  "threads.sendQueued",
  "threads.ready",
  "threads.stopCommand",
  "approvals.resolve",
  "hosted.review.action",
  "review.commitThread",
  "review.pushThread",
  "review.createThreadPr",
]);

export function assertNativeCall(threads: Threads, method: RoutedMethod, params: object): void {
  if (!writes.has(method)) return;
  const id = callThread(params);
  if (id && threads.row(id).parentId) throw new Refused("A subagent thread is read-only. Continue in its parent thread.");
}

function callThread(params: object): string | null {
  if ("threadId" in params && typeof params.threadId === "string") return params.threadId;
  if ("runId" in params && typeof params.runId === "string") return hostedThreadOf(params.runId);
  return "id" in params && typeof params.id === "string" ? params.id : null;
}
