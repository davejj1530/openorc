import { useQueryClient } from "@tanstack/react-query";
import { useRpc, useRpcMutation } from "./query";

export function useModelCatalog() {
  const client = useQueryClient();
  const query = useRpc("agents.modelCatalog", {}, { staleTime: 5 * 60_000 });
  const refresh = useRpcMutation("agents.models.refresh");
  return {
    ...query,
    data: query.data?.models,
    providers: query.data?.providers ?? [],
    isFetching: query.isFetching || refresh.isPending,
    isError: query.isError || refresh.isError,
    refreshModels: async () => {
      try {
        const catalog = await refresh.mutateAsync({});
        client.setQueryData(["agents.modelCatalog", {}], catalog);
        await client.invalidateQueries({ queryKey: ["agents.models"] });
      } catch {
        /* The picker displays the mutation's error and keeps its last list. */
      }
    },
  };
}
