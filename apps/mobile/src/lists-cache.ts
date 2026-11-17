import type { DeviceMethod, RpcMethod } from "@openorc/protocol";
import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";
import type { KeyValue } from "./scratch-store";

/**
 * The reads the phone paints from on a cold start, before the Mac answers: Home's lists and task list, the Mac's look in
 * its settings, the last usage it reported, and its agents' models and which of them are signed in, which a cloud
 * thread's composer and a new cloud thread choose from while the Mac is asleep.
 */
const KEPT: ReadonlySet<string> = new Set<RpcMethod | DeviceMethod>([
  "projects.list",
  "threads.list",
  "app.settings.get",
  "tasks.board",
  "providers.limits",
  "agents.models",
  "agents.availability",
  "cloudModels.catalog",
]);
const SAVE_AFTER_MS = 1_000;

type Storage = KeyValue;

interface Kept {
  key: QueryKey;
  data: unknown;
  at: number;
}

// Version 2: lists an earlier build saved could hold another host's threads.
const storageKey = (macId: string) => `lists.v2.${macId}`;
// A list whose latest read failed, as every read does while the Mac is asleep, still holds the last answer it had.
const kept = (query: Query) => KEPT.has(String(query.queryKey[0])) && query.state.data !== undefined;

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
  storage.remove(answersKey(macId));
}

/** Answers kept by what was asked: the router's word for what the Mac last said of a list it cannot answer now. */
export interface KeptAnswers {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

const answersKey = (macId: string) => `answers.v1.${macId}`;
/** The newest few answers a Mac gave, so a cold start with it asleep still lists its threads. */
const ANSWERS_KEPT = 12;

/**
 * The Mac's last answers to the lists the router asks of it, kept per shown Mac across launches, the newest
 * `ANSWERS_KEPT`: a phone opened with the Mac asleep lists its threads as the Mac last said them, as before a relaunch.
 */
export function keptAnswers(storage: Storage, shownMac: () => string | null): KeptAnswers {
  let heldFor: string | null = null;
  let held = new Map<string, unknown>();
  const current = () => {
    const macId = shownMac();
    if (macId !== heldFor) {
      heldFor = macId;
      held = new Map(macId ? readAnswers(storage, macId) : []);
    }
    return macId;
  };
  return {
    get(key) {
      current();
      return held.get(key);
    },
    set(key, value) {
      const macId = current();
      if (!macId) return;
      held.delete(key);
      held.set(key, value);
      while (held.size > ANSWERS_KEPT) held.delete(held.keys().next().value!);
      storage.set(answersKey(macId), JSON.stringify([...held]));
    },
  };
}

function readAnswers(storage: Storage, macId: string): [string, unknown][] {
  try {
    return JSON.parse(storage.getString(answersKey(macId)) ?? "[]") as [string, unknown][];
  } catch {
    return [];
  }
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
