import type { OnlineTaskPage, Project, SpaceProject } from "@openorc/protocol";
import { useQuery } from "@tanstack/react-query";
import { onlineTaskKey, onlineTaskTags, readOnlineTaskPages } from "@openorc/client";
import { core } from "./rpc";
import { useSpaceProjects, useSpaceRpc } from "./space-queries";
import { localTaskRecord, onlineTaskRecord } from "./task-records";
import { useTaskOnlineScope, useTaskOnlineQuery, type TaskOnlineScope } from "./task-online-query";
import { composedTaskAttention } from "./task-attention";
import type { TaskShelf } from "./task-list-state";

export function useTaskProjects(scope: TaskOnlineScope | null) {
  return useQuery({
    queryKey: ["online-tasks", scope?.accountId, scope?.spaceId, "projects"],
    queryFn: () => core.call("spaces.projects", { spaceId: scope?.spaceId ?? "" }),
    meta: { tags: onlineTaskTags(scope?.spaceId ?? "") },
    enabled: Boolean(scope),
    retry: false,
  });
}

/** One list reads both authorities, with no ID guessing or local persistence of online records. */
function useOnlineTaskList(projectId: string | null, assignedToMe: boolean, shelf: TaskShelf) {
  const { scope, availability } = useTaskOnlineScope();
  const projects = useTaskProjects(scope);
  const selected = projects.data?.find((project) => project.key === projectId);
  const input = {
    spaceId: scope?.spaceId ?? "",
    ...(selected?.hostedProjectId && { projectId: selected.hostedProjectId }),
    ...(assignedToMe && { assignee: "me" as const }),
    ...(shelf !== "active" && { status: shelf }),
  };
  const enabled = Boolean(scope && projects.data && (!projectId || selected?.hostedProjectId));
  const online = useQuery({
    queryKey: scope ? onlineTaskKey(scope, "list", { ...input, selected: projectId }) : ["online-tasks", "disabled-list"],
    queryFn: () => readOnlineTaskPages((page) => core.call("tasks.online.list", page), input),
    meta: { tags: onlineTaskTags(input.spaceId) },
    enabled,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
  });
  return { scope, availability, projects, online, enabled };
}

export function useTaskListSource(projectId: string | null, assignedToMe: boolean, shelf: TaskShelf = "active") {
  const local = useSpaceRpc("tasks.list", projectId ? { projectId } : {});
  const presentations = useSpaceProjects();
  const { scope, availability, projects, online, enabled } = useOnlineTaskList(projectId, assignedToMe, shelf);
  const localRows = assignedToMe && scope ? [] : (local.data ?? []).map(localTaskRecord);
  const onlineRows = onlineRecords(scope && enabled && !online.error ? scope : null, online.data, projects.data, presentations.data);
  return {
    data: [...localRows, ...onlineRows],
    scope,
    availability,
    error: local.error ?? (scope ? (projects.error ?? online.error) : null),
    isLoading: local.isLoading || Boolean(scope && (projects.isLoading || (enabled && online.isLoading))),
    refetch: async () => {
      await Promise.all([local.refetch(), ...(scope ? [projects.refetch(), ...(enabled ? [online.refetch()] : [])] : [])]);
    },
  };
}

export function useTaskAttentionCount(): number {
  const local = useSpaceRpc("tasks.list", {});
  const { scope } = useTaskOnlineScope();
  const online = useTaskOnlineQuery(scope, "tasks.online.attention", { spaceId: scope?.spaceId ?? "" });
  return composedTaskAttention(local.data ?? [], scope && !online.error ? (online.data?.count ?? 0) : 0);
}

function onlineRecords(scope: TaskOnlineScope | null, page: OnlineTaskPage | undefined, projects: SpaceProject[] = [], presentations: Project[] = []) {
  return scope ? (page?.tasks ?? []).map((task) => onlineTaskRecord(task, scope.accountId, projects, presentations)) : [];
}
