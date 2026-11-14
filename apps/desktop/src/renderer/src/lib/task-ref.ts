import { OnlineTaskRef } from "@openorc/protocol";
export { OnlineTaskRef } from "@openorc/protocol";
export type TaskRef = { kind: "local"; id: string } | OnlineTaskRef;

/** Legacy task IDs have exactly one meaning. An explicit online reference is never retried locally. */
export function resolveTaskRef(taskId: string, online?: OnlineTaskRef): TaskRef {
  if (!online) return { kind: "local", id: taskId };
  const reference = OnlineTaskRef.parse(online);
  if (reference.id !== taskId) throw new Error("This task isn't available.");
  return reference;
}
export function taskRefKey(reference: TaskRef): string {
  return reference.kind === "local" ? reference.id : `online:${JSON.stringify([reference.accountId, reference.spaceId, reference.projectId, reference.id])}`;
}
