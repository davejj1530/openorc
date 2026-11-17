import { useClaudeAccountId } from "./claude-account";
import { useQueryClient } from "@tanstack/react-query";
import { useRpc, useRpcMutation } from "./client";

/**
 * The models a picker offers: this Mac's, or with `cloud` the ones OpenOrc Cloud runs for the person, as its machines'
 * own agent CLIs list them. A server from before the cloud's catalog answers none, and this Mac's list stands in.
 */
export function useModelCatalog(cloud = false) {
  const client = useQueryClient();
  const claudeAccountId = useClaudeAccountId();
  const params = claudeAccountId ? { claudeAccountId } : {};
  const fromCloud = useRpc("cloudModels.catalog", {}, { enabled: cloud, staleTime: 5 * 60_000 });
  const served = cloud && fromCloud.data !== null;
  const query = useRpc("agents.modelCatalog", params, { staleTime: 5 * 60_000, enabled: !served });
  const refresh = useRpcMutation("agents.models.refresh");
  const shown = served ? fromCloud : query;
  return {
    ...shown,
    data: shown.data?.models,
    providers: shown.data?.providers ?? [],
    isFetching: shown.isFetching || refresh.isPending,
    isError: shown.isError || refresh.isError,
    refreshModels: async () => {
      if (served) return void (await fromCloud.refetch());
      try {
        const catalog = await refresh.mutateAsync(params);
        client.setQueryData(["agents.modelCatalog", params], catalog);
        await client.invalidateQueries({ queryKey: ["agents.models"] });
      } catch {
        /* The picker displays the mutation's error and keeps its last list. */
      }
    },
  };
}
