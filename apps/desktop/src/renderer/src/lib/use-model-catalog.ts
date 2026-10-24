import { useClaudeAccountId } from "./claude-account";
import { useQueryClient } from "@tanstack/react-query";
import { useRpc, useRpcMutation } from "./client";

export function useModelCatalog() {
  const client = useQueryClient();
  const claudeAccountId = useClaudeAccountId();
  const params = claudeAccountId ? { claudeAccountId } : {};
  const query = useRpc("agents.modelCatalog", params, { staleTime: 5 * 60_000 });
  const refresh = useRpcMutation("agents.models.refresh");
  return {
    ...query,
    data: query.data?.models,
    providers: query.data?.providers ?? [],
    isFetching: query.isFetching || refresh.isPending,
    isError: query.isError || refresh.isError,
    refreshModels: async () => {
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
