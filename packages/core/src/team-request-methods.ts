import type { RpcMethod } from "@openorc/protocol";

/*
 * The method lists OpenOrc.guardTeamRequest checks before any handler runs. A deleted conversation is reachable only
 * through its saved tasks: generic thread reads and mutations must not resurrect it, while historical file reads stay.
 */

/** Refused for a deleted conversation named by `id`. */
export const DELETED_BY_ID: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  "threads.fork",
  "threads.moveWorkspace",
  "threads.cancelMove",
  "threads.compact",
  "threads.queue",
  "threads.unqueue",
  "threads.sendQueued",
  "threads.stopCommand",
  "threads.checkpoints",
  "threads.turnChanges",
  "threads.restore",
  "threads.send",
]);

/** Refused for a deleted conversation named by `threadId`. */
export const DELETED_BY_THREAD: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  "review.threadDiff",
  "review.threadChanges",
  "review.threadFileDiff",
  "review.commitThread",
  "review.pushThread",
  "review.createThreadPr",
  "review.threadPrTemplate",
  "git.threadLog",
  "git.threadPushState",
  "runs.listForThread",
]);

/** Team controls that must name a task the conversation owns. */
export const TASK_SCOPED: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  "orchestration.turnChanges",
  "orchestration.stop",
  "orchestration.retry",
  "orchestration.compact",
  "orchestration.cancelDirection",
  "orchestration.sendNow",
  "orchestration.implementPlan",
  "orchestration.send",
  "orchestration.configureLead",
  "orchestration.workspace.retrySetup",
  "orchestration.workspace.acceptSetup",
  "orchestration.integration.retry",
  "orchestration.integration.accept",
]);
