import { onlineTaskTags } from "@openorc/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { OnlineTaskParams, OnlineTaskRef, OnlineTaskRpcResults, RpcParams, RpcResults } from "@openorc/protocol";
import { core } from "./rpc";
import { invalidateTags } from "./client";
import { useSpaceNavigation } from "./space-navigation";
import { organizationContentGate } from "./organization-content-gate";
import { useTaskContentGate } from "./task-content-gate";
import { readTaskContent } from "./task-access-cache";
import { taskRefreshInterval } from "./task-refresh";

type Method = keyof OnlineTaskRpcResults;
export type TaskOnlineScope = Pick<OnlineTaskRef, "accountId" | "spaceId">;
export const taskOnlineTags = onlineTaskTags;
export function useTaskOnlineQuery<M extends Method>(scope: TaskOnlineScope | null, method: M, params: RpcParams<M>, enabled = true) {
  return useQuery<RpcResults[M]>({
    queryKey: ["online-tasks", scope?.accountId, scope?.spaceId, method, params],
    queryFn: () => readTaskContent(organizationContentGate, scope, () => core.call(method, params)),
    meta: { tags: taskOnlineTags(scope?.spaceId ?? "") },
    enabled: Boolean(scope) && enabled,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => taskRefreshInterval(query.state.data),
  });
}
export function useTaskOnlineMutation<M extends Method>(scope: TaskOnlineScope, method: M) {
  return useMutation<RpcResults[M], Error, RpcParams<M>>({
    mutationKey: ["online-tasks", scope.accountId, scope.spaceId, method],
    mutationFn: (input) => readTaskContent(organizationContentGate, scope, () => core.call(method, input)),
    onSuccess: (_result, input: OnlineTaskParams<M>) => invalidateTags(taskOnlineTags(input.spaceId), { immediate: true }),
  });
}
/** No online request is added to the unchanged, unscoped Personal screen. */
export function useTaskOnlineScope() {
  const space = useSpaceNavigation((state) => state.inventory.find((space) => space.id === state.current));
  const gate = useTaskContentGate(space && !space.personal ? space.id : null);
  const enabled = Boolean(space?.accountId && !space.personal && gate.allowed);
  const candidate = enabled && space?.accountId ? { accountId: space.accountId, spaceId: space.id } : null;
  const status = useTaskOnlineQuery(candidate, "tasks.online.state", { spaceId: space?.id ?? "" });
  const ready = enabled && !status.error && status.data?.state === "ready" && status.data.accountId === space?.accountId ? status.data : null;
  return { scope: ready ? { accountId: ready.accountId, spaceId: ready.spaceId } : null, availability: ready, status };
}
