import type { QueryClient } from "@tanstack/react-query";
import type { OrganizationAccessStore } from "./organization-access-store";
import type { TaskOnlineScope } from "./task-online-query";
import { clearOnlineTaskListState } from "./task-list-state";

export async function readTaskContent<T>(gate: OrganizationAccessStore, scope: TaskOnlineScope | null, read: () => Promise<T>): Promise<T> {
  const ticket = scope ? gate.capture(scope.spaceId, scope.accountId) : null;
  if (!ticket?.current()) throw new Error("Project access changed. Try again.");
  const result = await read();
  if (!ticket.current()) throw new Error("Project access changed. Try again.");
  return result;
}

export function protectTaskCache(gate: OrganizationAccessStore, client: QueryClient, storage: Storage): () => void {
  return gate.subscribeProtected((change) => {
    client.removeQueries({ predicate: ({ queryKey }) => queryKey[0] === "online-tasks" && (change.reason === "account" || change.spaceIds.includes(String(queryKey[2]))) });
    const mutations = client.getMutationCache();
    for (const mutation of mutations.getAll()) {
      const key = mutation.options.mutationKey;
      if (key?.[0] === "online-tasks" && (change.reason === "account" || change.spaceIds.includes(String(key[2])))) mutations.remove(mutation);
    }
    const removed = change.reason === "account" ? change.spaceIds : change.removed;
    if (removed.length) {
      clearOnlineTaskListState(removed);
      removeTaskDrafts(storage, removed, change.reason === "account");
    }
  });
}

const prefixes = ["openorc.draft.task.online:", "openorc.draft.task-revision.online:", "openorc.draft.newtask.online."];
function removeTaskDrafts(storage: Storage, spaces: readonly string[], all: boolean): void {
  for (let index = storage.length - 1; index >= 0; --index) {
    const key = storage.key(index);
    const prefix = key && prefixes.find((value) => key.startsWith(value));
    if (!key || !prefix) continue;
    try {
      const scope: unknown = JSON.parse(key.slice(prefix.length));
      if (all || (Array.isArray(scope) && typeof scope[1] === "string" && spaces.includes(scope[1]))) storage.removeItem(key);
    } catch {
      /* Unreadable recovery data is never used as a server document. */
    }
  }
}
