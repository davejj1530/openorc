import type { RpcMethod } from "@openorc/protocol";
import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";
import type { MMKV } from "react-native-mmkv";

/** The reads the phone paints from on a cold start, before the Mac answers: Home's lists, and the Mac's look in its settings. */
const KEPT: ReadonlySet<RpcMethod> = new Set<RpcMethod>(["projects.list", "threads.list", "app.settings.get"]);
const SAVE_AFTER_MS = 1_000;

type Storage = Pick<MMKV, "getString" | "set" | "remove">;

interface Kept {
  key: QueryKey;
  data: unknown;
  at: number;
}

const storageKey = (macId: string) => `lists.${macId}`;
const kept = (query: Query) => KEPT.has(query.queryKey[0] as RpcMethod) && query.state.status === "success";

/** Puts a Mac's saved lists back in the cache, as old as they are, so they refetch once the Mac answers. */
export function restoreLists(client: QueryClient, storage: Storage, macId: string): boolean {
  let entries: Kept[];
  try {
    entries = JSON.parse(storage.getString(storageKey(macId)) ?? "[]") as Kept[];
  } catch {
    return false;
  }
  for (const entry of entries) client.setQueryData(entry.key, entry.data, { updatedAt: entry.at });
  return entries.length > 0;
}

export function forgetLists(storage: Storage, macId: string): void {
  storage.remove(storageKey(macId));
}

/** Saves the shown Mac's lists a moment after they change. */
export function keepLists(client: QueryClient, storage: Storage, shownMac: () => string | null): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    timer = null;
    const macId = shownMac();
    if (!macId) return;
    const entries: Kept[] = client
      .getQueryCache()
      .findAll({ predicate: kept })
      .map((query) => ({ key: query.queryKey, data: query.state.data, at: query.state.dataUpdatedAt }));
    storage.set(storageKey(macId), JSON.stringify(entries));
  };
  return client.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success" || !kept(event.query)) return;
    timer ??= setTimeout(save, SAVE_AFTER_MS);
  });
}
