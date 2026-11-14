import type { Project, RpcMethod, RpcParams, SpaceProject, SpacesStatus, ThreadSummary } from "@openorc/protocol";
import type { RpcQueryOptions } from "@openorc/client";
import { useEffect } from "react";
import { useRpc, useRpcs } from "./client";
import { core } from "./rpc";
import { spaceNavigation, useSpaceNavigation } from "./space-navigation";

const SCOPED = new Set<RpcMethod>(["threads.list", "threads.resolvedCount", "threads.search", "tasks.list"]);

export function spaceParams<M extends RpcMethod>(method: M, params: RpcParams<M>, spaceId: string | null, ownership: "mine" | "everyone"): RpcParams<M> {
  return spaceId && SCOPED.has(method) ? { ...params, spaceId, ...(["threads.list", "threads.resolvedCount"].includes(method) ? { ownership } : {}) } : params;
}

/** Query keys include the captured space, so a late answer can only populate that space's query. */
export function useSpaceRpc<M extends RpcMethod>(method: M, params: RpcParams<M>, options?: RpcQueryOptions<M>) {
  const current = useSpaceNavigation((state) => state.current);
  const key = useSpaceNavigation((state) => state.key);
  const ownership = useSpaceNavigation((state) => state.ownership);
  const result = useRpc(method, spaceParams(method, params, current, ownership), options);
  useEffect(() => {
    if (current && method === "threads.list" && result.data) spaceNavigation.getState().observe(current, result.data as ThreadSummary[], key);
  }, [current, key, method, result.data]);
  return result;
}
export function useSpaceRpcs<M extends RpcMethod>(method: M, params: readonly RpcParams<M>[], options?: RpcQueryOptions<M>) {
  const current = useSpaceNavigation((state) => state.current);
  const key = useSpaceNavigation((state) => state.key);
  const ownership = useSpaceNavigation((state) => state.ownership);
  const results = useRpcs(
    method,
    params.map((input) => spaceParams(method, input, current, ownership)),
    options,
  );
  useEffect(() => {
    if (current && method === "threads.list")
      spaceNavigation.getState().observe(
        current,
        results.flatMap((result) => (result.data ?? []) as ThreadSummary[]),
        key,
      );
  }, [current, key, method, results]);
  return results;
}

/** Direct ID reads keep their wire shape; this window supplies the project's scoped presentation. */
export function useSpaceThread(id: string, options?: RpcQueryOptions<"threads.get">) {
  const result = useRpc("threads.get", { id }, options);
  const projectId = useSpaceNavigation((state) => state.inventory.find((space) => space.id === state.current)?.threads.find((thread) => thread.id === id)?.projectId);
  return { ...result, data: result.data && projectId ? { ...result.data, projectId } : result.data };
}

/** Cloud-only presentations read the core's project facade; no folder or local settings are invented here. */
export function useSpaceProjects(localOnly = false) {
  const current = useSpaceNavigation((state) => state.current);
  const local = useRpc("projects.list", {});
  const scoped = useRpc("spaces.projects", { spaceId: current ?? "" }, { enabled: current !== null });
  const remote = useRpcs("projects.get", current ? (scoped.data ?? []).filter((project) => !project.localProjectId).map((project) => ({ id: project.key })) : []);
  const data = current ? projectData(scoped.data, local.data, remote) : local.data;
  const queries = current ? [local, scoped, ...remote] : [local];
  return {
    ...local,
    data: localOnly ? data?.filter((project) => project.rootPath !== "") : data,
    isPending: queries.some((query) => query.isPending),
    isError: queries.some((query) => query.isError),
    error: queries.find((query) => query.error)?.error ?? null,
    refetch: async () => {
      await Promise.all([local.refetch(), ...(current ? [scoped.refetch(), ...remote.map((query) => query.refetch())] : [])]);
    },
  };
}

function projectData(scoped: SpaceProject[] | undefined, local: Project[] | undefined, remote: { data: Project | null | undefined; isPending: boolean }[]): Project[] | undefined {
  if (!scoped || !local || remote.some((query) => query.isPending)) return undefined;
  const all = [...local, ...remote.flatMap((query) => query.data ?? [])];
  return scoped.flatMap((row) => {
    const project = all.find((project) => project.id === row.key);
    return project ? { ...project, ...(!row.localProjectId && { cloud: true }) } : [];
  });
}

let reading = 0;

/** Called only by the completed space entry point, or by the isolated renderer fixture before it is mounted. */
export async function reconcileSpaceNavigation(status: SpacesStatus, coreIdentity: string): Promise<void> {
  const turn = ++reading;
  if (status.state === "unavailable" || status.state === "signed-out") {
    if (spaceNavigation.getState().key) spaceNavigation.getState().end();
    return;
  }
  if (status.state !== "ready") return;
  const inventory = await Promise.all(
    status.spaces.map(async (space) => ({
      id: space.id,
      personal: space.kind === "personal",
      projects: await core.call("spaces.projects", { spaceId: space.id }),
      threads: await core.call("threads.list", { spaceId: space.id, filter: "all", includeChildren: true }),
      taskIds: (await core.call("tasks.list", { spaceId: space.id })).map((task) => task.id),
    })),
  );
  if (turn !== reading) return;
  const key = `openorc.spaces.v1:${encodeURIComponent(coreIdentity)}:${encodeURIComponent(status.apiOrigin)}:${encodeURIComponent(status.userId)}`;
  spaceNavigation.getState().initialize(key, status.personalSpaceId, inventory);
}
