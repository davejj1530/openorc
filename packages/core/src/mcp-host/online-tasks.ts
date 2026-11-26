import type { OnlineTaskTools } from "../services/online-task-tools.js";

/** A Mac agent's tools for its project's tasks on OpenOrc Cloud, where this core has them. */
export type OnlineTasksHost = Pick<OnlineTaskTools, "list" | "get" | "create" | "update" | "start" | "context" | "report"> | null;

/** A call that names a cloud project goes there or nowhere: it never falls through to this Mac's tasks. */
export function onlineTasks(online: OnlineTasksHost): NonNullable<OnlineTasksHost> {
  if (!online) throw new Error("Online task tools aren't available here.");
  return online;
}
