import type { OnlineTaskPage, OnlineTaskParams, OnlineTaskRef } from "@openorc/protocol";

export type OnlineTaskScope = Pick<OnlineTaskRef, "accountId" | "spaceId">;
/** Query identity includes the account even when two accounts can read the same organization. */
export function onlineTaskKey(scope: OnlineTaskScope, operation: string, params: object = {}): readonly unknown[] {
  return ["online-tasks", scope.accountId, scope.spaceId, operation, params];
}
export function onlineTaskTags(spaceId: string): string[] {
  return ["online-tasks", `online-tasks:${spaceId}`, "spaces", "projects"];
}

/** A failed or inconsistent page never becomes a complete list or an attention count. */
export async function readOnlineTaskPages(read: (input: OnlineTaskParams<"tasks.online.list">) => Promise<OnlineTaskPage>, input: OnlineTaskParams<"tasks.online.list">): Promise<OnlineTaskPage> {
  const tasks: OnlineTaskPage["tasks"] = [];
  const cursors = new Set<string>();
  let cursor = input.cursor,
    accessRevision: number | undefined;
  do {
    const page = await read({ ...input, ...(cursor !== undefined && { cursor }) });
    if (accessRevision !== undefined && accessRevision !== page.accessRevision) throw new Error("Project access changed. Try again.");
    accessRevision = page.accessRevision;
    tasks.push(...page.tasks);
    if (page.cursor === null) return { tasks: [...new Map(tasks.map((task) => [task.id, task])).values()], accessRevision, cursor: null };
    if (cursors.has(page.cursor)) throw new Error("The task list couldn't finish loading. Try again.");
    cursors.add(page.cursor);
    cursor = page.cursor;
  } while (cursor !== undefined);
  throw new Error("The task list couldn't finish loading. Try again.");
}
