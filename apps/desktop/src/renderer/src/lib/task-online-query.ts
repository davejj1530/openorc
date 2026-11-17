import { onlineTaskTags } from "@openorc/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { OnlineTaskAvailability, OnlineTaskExecutionRpcResults, OnlineTaskRef, OnlineTaskRpcResults, RpcParams, RpcResults } from "@openorc/protocol";
import { core } from "./rpc";
import { invalidateTags } from "./client";
import { useSpaceNavigation } from "./space-navigation";
import { organizationContentGate } from "./organization-content-gate";
import { useTaskContentGate } from "./task-content-gate";
import { readTaskContent } from "./task-access-cache";
import { taskRefreshInterval } from "./task-refresh";

type Method = keyof OnlineTaskRpcResults | keyof OnlineTaskExecutionRpcResults;
export type TaskOnlineScope = Pick<OnlineTaskRef, "accountId" | "spaceId">;
export const taskOnlineTags = onlineTaskTags;
export function useTaskOnlineQuery<M extends keyof OnlineTaskRpcResults>(scope: TaskOnlineScope | null, method: M, params: RpcParams<M>, enabled = true) {
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
    onSuccess: (_result, input) => invalidateTags(taskOnlineTags(input.spaceId), { immediate: true }),
  });
}
/** Whether a space is the person's own Personal one, whose tasks nobody else reads, so none is assigned. */
export function usePersonalSpace(spaceId: string): boolean {
  return useSpaceNavigation((state) => state.inventory.find((space) => space.id === spaceId)?.personal === true);
}

/**
 * The current space's tasks on OpenOrc Cloud. An organization's are its whole list; the person's Personal space's own sit
 * beside this Mac's tasks (`personal`), with no assignment, since nobody else reads them. Signed out, there are none.
 */
export function useTaskOnlineScope(): {
  scope: (TaskOnlineScope & { personal: boolean }) | null;
  availability: OnlineTaskAvailability | null;
  status: ReturnType<typeof useTaskOnlineQuery<"tasks.online.state">>;
} {
  const space = useSpaceNavigation((state) => state.inventory.find((space) => space.id === state.current));
  const personal = Boolean(space?.personal);
  // A Personal space waits for the same account read as an organization's, which lists it as the person's own.
  const gate = useTaskContentGate(space?.id ?? null);
  const enabled = Boolean(space?.accountId && gate.allowed);
  const candidate = enabled && space?.accountId ? { accountId: space.accountId, spaceId: space.id } : null;
  const status = useTaskOnlineQuery(candidate, "tasks.online.state", { spaceId: space?.id ?? "" });
  const ready = enabled && !status.error && status.data?.state === "ready" && status.data.accountId === space?.accountId ? status.data : null;
  return { scope: ready ? { accountId: ready.accountId, spaceId: ready.spaceId, personal } : null, availability: ready, status };
}
