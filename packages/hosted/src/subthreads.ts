import { HOSTED_REASONS, type RpcParams, type RpcResults } from "@openorc/protocol";
import { Refused, type Requests } from "./session.js";
import type { Threads } from "./threads.js";
import { toRuns } from "./translate.js";
import { ROUTES, type WireThread } from "./wire.js";
import { isNativeHelper, SUBTHREAD_ROUTES, type NativeThread, type WireNativeChild } from "./wire-subthreads.js";

export const NATIVE_UNAVAILABLE = HOSTED_REASONS.nativeSubthreads;
export const NATIVE_STOP_UNAVAILABLE = "This subagent can't be stopped separately.";

export async function readNativeChildren(on: Requests, id: string): Promise<WireNativeChild[]> {
  try {
    return (await on.request(SUBTHREAD_ROUTES.children(id))).children;
  } catch (error) {
    if (!(error instanceof Refused) || error.status !== 404) throw error;
    await on.request(ROUTES.thread(id));
    throw new Refused(NATIVE_UNAVAILABLE);
  }
}

export async function readNativeThread(on: Requests, id: string): Promise<NativeThread> {
  const row = await on.request(ROUTES.thread(id));
  const child = (await readNativeChildren(on, id)).find((item) => item.id === id);
  if (!child) throw new Refused("This subthread is no longer available.");
  return { ...row, parentId: child.parentId, nativeChild: child };
}

/** Each family is read once. Missing ancestors and children beyond the main list's limit are registered together. */
export async function readNativeRows(on: Requests, listed: WireThread[], previous: NativeThread[]): Promise<NativeThread[]> {
  const rows = new Map<string, NativeThread>(listed.map((row) => [row.id, row]));
  const before = new Map(previous.map((row) => [row.id, row]));
  const families = new Set(listed.filter(isNativeHelper).map((row) => rootOf(row, rows)));
  const keys = new Map([...families].map((id) => [id, nativeFamilyKey(id, rows)]));
  for (const id of families) {
    const key = keys.get(id)!;
    if (reuseFamily(key, rows, previous)) continue;
    try {
      const children = await readNativeChildren(on, id);
      await fillFamily(on, rows, children, key);
    } catch (error) {
      const family = [...rows].filter(([, row]) => rootOf(row, rows) === id);
      for (const [key, row] of family) {
        if (error instanceof Refused && (error.status === 403 || error.status === 404)) rows.delete(key);
        else if (isNativeHelper(row)) rows.set(key, { ...row, nativeChild: before.get(key)?.nativeChild, nativeReadFailed: true });
      }
    }
  }
  return [...rows.values()];
}

function nativeFamilyKey(id: string, rows: ReadonlyMap<string, NativeThread>): string {
  const family = [...rows.values()].filter((row) => rootOf(row, rows) === id);
  return JSON.stringify([id, family.map((row) => [row.id, row.parentId, row.head, row.status, row.lastActivityAt]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
}

function reuseFamily(key: string, rows: Map<string, NativeThread>, previous: NativeThread[]): boolean {
  const cached = previous.filter((row) => row.nativeListKey === key);
  if (!cached.length || cached.some((row) => row.nativeReadFailed || row.nativeChild?.status === "running")) return false;
  for (const row of cached) rows.set(row.id, { ...row, ...rows.get(row.id) });
  return true;
}

/** The thread a helper's family is read under: up through helpers, to the first thread that is no agent's helper. */
function rootOf(row: WireThread, rows: ReadonlyMap<string, WireThread>): string {
  const seen = new Set<string>();
  while (isNativeHelper(row) && row.parentId && !seen.has(row.id)) {
    seen.add(row.id);
    const parent = rows.get(row.parentId);
    if (!parent) return row.parentId;
    row = parent;
  }
  return row.id;
}

async function fillFamily(on: Requests, rows: Map<string, NativeThread>, children: WireNativeChild[], nativeListKey: string): Promise<void> {
  const read = new Map<string, NativeThread>();
  for (const child of children) {
    if (!read.has(child.rootId)) read.set(child.rootId, { ...(rows.get(child.rootId) ?? (await on.request(ROUTES.thread(child.rootId)))), nativeListKey });
    const row = rows.get(child.id) ?? (await on.request(ROUTES.thread(child.id)));
    read.set(child.id, { ...row, parentId: child.parentId, nativeChild: child, nativeListKey });
  }
  for (const [id, row] of read) rows.set(id, row);
}

export async function nativeRuns(threads: Threads, { threadId }: RpcParams<"runs.listForThread">): Promise<RpcResults["runs.listForThread"]> {
  const row = threads.row(threadId);
  return toRuns(isNativeHelper(row) ? await readNativeThread(threads.on(threadId), threadId) : row, threads.reach);
}

/** Keep the same request after a lost response, fenced to the exact handle the reader selected. */
export async function stopNative(threads: Threads, { threadId, expectedRunId }: RpcParams<"subagents.stop">): Promise<null> {
  if (!expectedRunId || !isNativeHelper(threads.row(threadId))) throw new Refused(NATIVE_STOP_UNAVAILABLE);
  const on = threads.on(threadId);
  const child = (await readNativeThread(on, threadId)).nativeChild!;
  if (child.status === "running" && (!child.stoppable || child.hostRunId !== expectedRunId)) throw new Refused(NATIVE_STOP_UNAVAILABLE);
  const account = threads.calls.account();
  if (account.state !== "signed-in") throw new Refused("Sign in to OpenOrc first.");
  const id = threads.nativeStopRequest(threadId, expectedRunId);
  await on.request(SUBTHREAD_ROUTES.stop(threadId), { id, expectedRunId });
  void threads.refresh();
  return null;
}
