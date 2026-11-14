import { onlineTaskTags } from "@openorc/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { OnlineTaskParams, OnlineTaskRef, OnlineTaskRpcResults, RpcParams, RpcResults } from "@openorc/protocol";
import { core } from "./rpc";
import { invalidateTags } from "./client";
import { useSpaceNavigation } from "./space-navigation";

type Method = keyof OnlineTaskRpcResults;
export type TaskOnlineScope = Pick<OnlineTaskRef, "accountId" | "spaceId">;
export const taskOnlineTags = onlineTaskTags;
export function useTaskOnlineQuery<M extends Method>(scope: TaskOnlineScope | null, method: M, params: RpcParams<M>, enabled = true) {
  return useQuery<RpcResults[M]>({
    queryKey: ["online-tasks", scope?.accountId, scope?.spaceId, method, params],
    queryFn: () => core.call(method, params),
    meta: { tags: taskOnlineTags(scope?.spaceId ?? "") },
    enabled: Boolean(scope) && enabled,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
  });
}
export function useTaskOnlineMutation<M extends Method>(method: M) {
  return useMutation<RpcResults[M], Error, RpcParams<M>>({
    mutationFn: (input) => core.call(method, input),
    onSuccess: (_result, input: OnlineTaskParams<M>) => invalidateTags(taskOnlineTags(input.spaceId), { immediate: true }),
  });
}
/** No online request is added to the unchanged, unscoped Personal screen. */
export function useTaskOnlineScope() {
  const space = useSpaceNavigation((state) => state.inventory.find((space) => space.id === state.current));
  const enabled = Boolean(space?.accountId && !space.personal);
  const candidate = enabled && space?.accountId ? { accountId: space.accountId, spaceId: space.id } : null;
  const status = useTaskOnlineQuery(candidate, "tasks.online.state", { spaceId: space?.id ?? "" });
  const ready = enabled && !status.error && status.data?.state === "ready" && status.data.accountId === space?.accountId ? status.data : null;
  return { scope: ready ? { accountId: ready.accountId, spaceId: ready.spaceId } : null, availability: ready, status };
}
