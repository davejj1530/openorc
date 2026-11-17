import { QueryClient, useMutation, useQueries, useQuery, type Query, type UseQueryOptions } from "@tanstack/react-query";
import type { RpcMethod, RpcParams, RpcResults } from "@openorc/protocol";
import type { CoreConnection } from "./connection.js";
import { invalidatesFor, tagsFor } from "./query-tags.js";

export type RpcQueryOptions<M extends RpcMethod> = Partial<Pick<UseQueryOptions<RpcResults[M]>, "enabled" | "staleTime" | "gcTime" | "refetchInterval" | "placeholderData">>;

interface QueryState {
  readonly connection: CoreConnection;
  readonly client: QueryClient;
  /** How long pushed invalidations gather before one refetch pass. */
  readonly batchMs: number;
  readonly pendingTags: Set<string>;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

/** The key the core pushes when a thread is read at another place from now on (a move between this Mac and OpenOrc Cloud). */
const PLACE = "place:";

/** Whether a read is about the thread: named by its params, or a run of it in OpenOrc Cloud. */
function readsThread(query: Query, threadId: string): boolean {
  const params = query.queryKey[1] as Record<string, unknown> | undefined;
  const scope = params?.["scope"] as { id?: unknown } | undefined;
  return params?.["threadId"] === threadId || params?.["id"] === threadId || scope?.id === threadId || params?.["runId"] === `hosted:${threadId}`;
}

/** A turn of the event loop: by then the screen has drawn what the cache just took. */
const drawn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Threads read at another place from now on. What each is now is read first, and the screen draws it, so what it
 * showed for the old place unmounts or stops asking; then its reads no reader holds any more are dropped, and the rest
 * are read again where it is. A read of the old place is never asked again.
 */
async function moved(q: QueryState, threadIds: readonly string[]): Promise<void> {
  await Promise.all(threadIds.map((id) => q.client.refetchQueries({ queryKey: ["threads.get", { id }], exact: true })));
  await drawn();
  await drawn();
  const about = (query: Query) => query.queryKey[0] !== "threads.get" && threadIds.some((id) => readsThread(query, id));
  q.client.removeQueries({ predicate: (query) => about(query) && query.getObserversCount() === 0 });
  await q.client.invalidateQueries({ predicate: about });
}

function flushInvalidations(q: QueryState, cancelRefetch = true): void {
  if (q.flushTimer) {
    clearTimeout(q.flushTimer);
    q.flushTimer = null;
  }
  if (q.pendingTags.size === 0) return;
  const batch = new Set(q.pendingTags);
  q.pendingTags.clear();
  const threadIds = [...batch].flatMap((tag) => (tag.startsWith(PLACE) ? [tag.slice(PLACE.length)] : []));
  if (threadIds.length) void moved(q, threadIds).then(() => refresh(q, batch, cancelRefetch, (query) => !threadIds.some((id) => readsThread(query, id))));
  else refresh(q, batch, cancelRefetch);
}

/** Reads the batch's tags name again; `outside`, when given, keeps the reads it refuses out of the pass. */
function refresh(q: QueryState, batch: ReadonlySet<string>, cancelRefetch: boolean, outside: (query: Query) => boolean = () => true): void {
  const predicate = (query: Query) => outside(query) && ((query.meta?.["tags"] as string[] | undefined) ?? []).some((t) => batch.has(t));
  // Without cancelling, a read already loading absorbs this refresh, yet it may predate the change announced: read it once more after.
  const loading = cancelRefetch ? [] : q.client.getQueryCache().findAll({ predicate, fetchStatus: "fetching" });
  void q.client.invalidateQueries({ predicate }, { cancelRefetch }).then(() => {
    for (const query of loading) void q.client.invalidateQueries({ queryKey: query.queryKey, exact: true }, { cancelRefetch: false });
  });
}

/**
 * Every provider event invalidates the same few tags; one refetch pass per short
 * window is all the screen can use. The user's own actions refresh at once.
 */
function invalidateTags(q: QueryState, keys: string[], options: { immediate?: boolean } = {}): void {
  if (keys.length === 0) return;
  for (const key of keys) q.pendingTags.add(key);
  if (options.immediate) {
    flushInvalidations(q);
    return;
  }
  // Pushed while agents work, sometimes every second: a slow read still loading, such as a large diff, finishes instead of restarting.
  if (!q.flushTimer) q.flushTimer = setTimeout(() => flushInvalidations(q, false), q.batchMs);
}

function rpcQuery<M extends RpcMethod>(q: QueryState, method: M, params: RpcParams<M>, options: RpcQueryOptions<M>): UseQueryOptions<RpcResults[M]> {
  const queryKey = [method, params];
  return {
    queryKey,
    queryFn: () => q.connection.call(method, params),
    meta: { tags: tagsFor(method, params) },
    ...options,
  };
}

function useRpcOf<M extends RpcMethod>(q: QueryState, method: M, params: RpcParams<M>, options: RpcQueryOptions<M> = {}) {
  return useQuery<RpcResults[M]>(rpcQuery(q, method, params, options));
}

/** One read of `method` per params, for a list of them that grows and shrinks, each keyed as `useRpc` keys it. */
function useRpcsOf<M extends RpcMethod>(q: QueryState, method: M, paramsList: readonly RpcParams<M>[], options: RpcQueryOptions<M> = {}) {
  return useQueries({ queries: paramsList.map((params) => rpcQuery(q, method, params, options)) });
}

function useRpcMutationOf<M extends RpcMethod>(q: QueryState, method: M) {
  return useMutation<RpcResults[M], Error, RpcParams<M>>({
    mutationFn: (params) => q.connection.call(method, params),
    onSuccess: (_result, params) => invalidateTags(q, invalidatesFor(method, params), { immediate: true }),
  });
}

/** The query cache over one connection: reads keyed by method and params, tagged so writes and pushes refresh them. */
export function createQueries(connection: CoreConnection, invalidationBatchMs: number) {
  const q: QueryState = {
    connection,
    client: new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } } }),
    batchMs: invalidationBatchMs,
    pendingTags: new Set(),
    flushTimer: null,
  };
  return {
    queryClient: q.client,
    invalidateTags: (keys: string[], options?: { immediate?: boolean }) => invalidateTags(q, keys, options),
    useRpc: <M extends RpcMethod>(method: M, params: RpcParams<M>, options?: RpcQueryOptions<M>) => useRpcOf(q, method, params, options),
    useRpcs: <M extends RpcMethod>(method: M, paramsList: readonly RpcParams<M>[], options?: RpcQueryOptions<M>) => useRpcsOf(q, method, paramsList, options),
    useRpcMutation: <M extends RpcMethod>(method: M) => useRpcMutationOf(q, method),
    /** A read as useRpc would hold it: from the cache when there, otherwise loaded into it. */
    ensureRpc: <M extends RpcMethod>(method: M, params: RpcParams<M>) => q.client.ensureQueryData<RpcResults[M]>(rpcQuery(q, method, params, {})),
  };
}

export type ClientQueries = ReturnType<typeof createQueries>;
