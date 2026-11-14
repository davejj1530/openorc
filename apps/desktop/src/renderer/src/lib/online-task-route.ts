import { OnlineTaskRef } from "./task-ref";
import type { Route, TaskTab } from "./router";

function isTaskTab(tab: unknown): tab is TaskTab {
  return tab === "chat" || tab === "spec" || tab === "files" || tab === "commits" || tab === "memory";
}
export function onlineTaskRouteSpec(reference: OnlineTaskRef, tab: TaskTab): string {
  return ["online-task", reference.accountId, reference.spaceId, reference.projectId, reference.id, tab].map(encodeURIComponent).join(":");
}
export function onlineTaskDestination(reference: OnlineTaskRef, tab: unknown): Route | null {
  return isTaskTab(tab) ? { view: "task", taskId: reference.id, taskRef: reference, tab } : null;
}
export function onlineTaskRouteFromSpec(spec: string): Route | null {
  try {
    const [view, accountId, spaceId, projectId, id, tab, extra] = spec.split(":").map(decodeURIComponent);
    if (view !== "online-task" || extra !== undefined) return null;
    const reference = OnlineTaskRef.safeParse({ kind: "online", accountId, spaceId, projectId, id });
    return reference.success ? onlineTaskDestination(reference.data, tab) : null;
  } catch {
    return null;
  }
}
