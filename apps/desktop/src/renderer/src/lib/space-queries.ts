import type { Project, RpcMethod, RpcParams, SpaceProject, SpacesStatus, ThreadSummary } from "@openorc/protocol";
import { WORKSPACE_ID } from "@openorc/protocol";
import type { RpcQueryOptions } from "@openorc/client";
import { useEffect, useSyncExternalStore } from "react";
import { useRpc, useRpcs } from "./client";
import { core } from "./rpc";
import { spaceNavigation, useSpaceNavigation } from "./space-navigation";
import { purgeSpaceAccess } from "./space-access";
import { organizationContentGate } from "./organization-content-gate";
import { organizationContentState } from "./organization-access-store";
import { organizationLease } from "./organization-frozen-content";
import { closedSpace, type SpaceInventory } from "./space-view";

const SCOPED = new Set<RpcMethod>(["threads.list", "threads.resolvedCount", "threads.search", "tasks.list"]);

export function spaceParams<M extends RpcMethod>(method: M, params: RpcParams<M>, spaceId: string | null, ownership: "mine" | "everyone"): RpcParams<M> {
  return spaceId && SCOPED.has(method) ? { ...params, spaceId, ...(["threads.list", "threads.resolvedCount"].includes(method) ? { ownership } : {}) } : params;
}

/** Whether the space is an organization this person is frozen out of: nothing of it is asked for or shown. */
function useFrozenSpace(spaceId: string | null): boolean {
  const snapshot = useSyncExternalStore(organizationContentGate.subscribe, organizationContentGate.getSnapshot);
  return organizationContentState(snapshot, spaceId).blocked === "frozen";
}
/** An answer that reached the cache after the organization closed is never handed on. */
const withheld = <T extends { data: unknown }>(result: T): T => ({ ...result, data: undefined });

/** Query keys include the captured space, so a late answer can only populate that space's query. */
export function useSpaceRpc<M extends RpcMethod>(method: M, params: RpcParams<M>, options?: RpcQueryOptions<M>) {
  const current = useSpaceNavigation((state) => state.current);
  const key = useSpaceNavigation((state) => state.key);
  const ownership = useSpaceNavigation((state) => state.ownership);
  const frozen = useFrozenSpace(current);
  const read = useRpc(method, spaceParams(method, params, current, ownership), frozen ? { ...options, enabled: false } : options);
  const result = frozen ? withheld(read) : read;
  useEffect(() => {
    if (current && method === "threads.list" && result.data) spaceNavigation.getState().observe(current, result.data as ThreadSummary[], key);
  }, [current, key, method, result.data]);
  return result;
}
export function useSpaceRpcs<M extends RpcMethod>(method: M, params: readonly RpcParams<M>[], options?: RpcQueryOptions<M>) {
  const current = useSpaceNavigation((state) => state.current);
  const key = useSpaceNavigation((state) => state.key);
  const ownership = useSpaceNavigation((state) => state.ownership);
  const frozen = useFrozenSpace(current);
  const results = useRpcs(method, frozen ? [] : params.map((input) => spaceParams(method, input, current, ownership)), options);
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
  const frozen = useFrozenSpace(useSpaceNavigation((state) => state.current));
  const unavailable = Boolean(useUnavailableThread(id)) || frozen;
  const result = useRpc("threads.get", { id }, { ...options, ...(unavailable && { enabled: false }) });
  const known = useSpaceNavigation((state) => state.inventory.find((space) => space.id === state.current)?.threads.find((thread) => thread.id === id));
  const awaitingAccess = !unavailable && result.isSuccess && result.data === null && known?.owner?.brain === "hosted";
  const data = result.data && known?.projectId ? { ...result.data, projectId: known.projectId } : result.data;
  return { ...result, awaitingAccess, knownTitle: frozen ? undefined : known?.title, data: unavailable ? null : data };
}

export function useUnavailableThread(id: string) {
  return useSpaceNavigation((state) => state.inventory.find((space) => space.id === state.current)?.unavailable?.find((row) => row.id === id));
}

/** Cloud-only presentations read the core's project facade; no folder or local settings are invented here. */
export function useSpaceProjects(localOnly = false, includeDetached = false) {
  const current = useSpaceNavigation((state) => state.current);
  const detached = useSpaceNavigation((state) => (includeDetached ? state.inventory.find((space) => space.id === state.current)?.detached?.projects : undefined));
  const frozen = useFrozenSpace(current);
  const local = useRpc("projects.list", {});
  const asked = useRpc("spaces.projects", { spaceId: current ?? "" }, { enabled: current !== null && !frozen });
  const scoped = frozen ? withheld(asked) : asked;
  const remote = useRpcs("projects.get", current ? (scoped.data ?? []).filter((project) => !project.localProjectId).map((project) => ({ id: project.key })) : []);
  const data = current ? projectData(scoped.data && [...scoped.data, ...(detached ?? [])], local.data, remote) : local.data;
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
let reconciliation: Promise<void> = Promise.resolve();

/** Called only by the completed space entry point, or by the isolated renderer fixture before it is mounted. */
export function reconcileSpaceNavigation(status: SpacesStatus, coreIdentity: string): Promise<void> {
  const turn = ++reading;
  const read = readSpaceNavigation(status, coreIdentity, turn);
  // An explicit opening waits for the background read that superseded it before selecting its destination.
  reconciliation = read.then(
    () => (turn === reading ? undefined : reconciliation),
    (error: unknown) => {
      if (turn !== reading) return reconciliation;
      throw error;
    },
  );
  return reconciliation;
}

async function readSpaceNavigation(status: SpacesStatus, coreIdentity: string, turn: number): Promise<void> {
  if (status.state === "unavailable" || status.state === "signed-out") {
    if (spaceNavigation.getState().key) spaceNavigation.getState().end();
    return;
  }
  if (status.state !== "ready") return;
  if (!spaceNavigation.getState().key && status.spaces.every((space) => space.kind === "personal")) return;
  const lease = organizationLease(organizationContentGate, status);
  const listed = await Promise.all(
    status.spaces.map(async (space): Promise<SpaceInventory> => {
      // A frozen person's organization keeps its place in the switcher and is asked for none of its content.
      if (lease.frozen && space.kind === "organization") return closedSpace({ id: space.id, accountId: status.userId });
      return {
        id: space.id,
        accountId: status.userId,
        personal: space.kind === "personal",
        projects: await core.call("spaces.projects", { spaceId: space.id }),
        threads: await core.call("threads.list", { spaceId: space.id, filter: "all", includeChildren: true }),
        taskIds: (await core.call("tasks.list", { spaceId: space.id })).map((task) => task.id),
      };
    }),
  );
  if (turn !== reading) return;
  const held = lease.held();
  if (held === "again") return readSpaceNavigation(status, coreIdentity, turn);
  if (held === "ended") return;
  const inventory = listed.map((space) => ({
    ...space,
    threads: space.threads.filter((row) => (space.personal && row.projectId === WORKSPACE_ID) || space.projects.some((project) => project.key === row.projectId)),
  }));
  const key = `openorc.spaces.v1:${encodeURIComponent(coreIdentity)}:${encodeURIComponent(status.apiOrigin)}:${encodeURIComponent(status.userId)}`;
  if (spaceNavigation.getState().key === key) purgeSpaceAccess(spaceNavigation.getState().inventory, inventory);
  spaceNavigation.getState().initialize(key, status.personalSpaceId, inventory);
}
