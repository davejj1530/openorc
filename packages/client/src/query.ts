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

function flushInvalidations(q: QueryState, cancelRefetch = true): void {
  if (q.flushTimer) {
    clearTimeout(q.flushTimer);
    q.flushTimer = null;
  }
  if (q.pendingTags.size === 0) return;
  const batch = new Set(q.pendingTags);
  q.pendingTags.clear();
  const predicate = (query: Query) => ((query.meta?.["tags"] as string[] | undefined) ?? []).some((t) => batch.has(t));
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
  return {
    queryKey: [method, params],
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
  };
}

export type ClientQueries = ReturnType<typeof createQueries>;
