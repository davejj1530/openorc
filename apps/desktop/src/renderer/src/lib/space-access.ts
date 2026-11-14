import { hostedRunId } from "@openorc/protocol";
import type { Query } from "@tanstack/react-query";
import { queryClient, runs } from "./client";
import type { SpaceInventory, SpaceView } from "./space-view";

/** Only titles of already open tabs survive a project revocation, in this window's memory. */
export function retainUnavailable(before: SpaceInventory[], after: SpaceInventory[], views: Record<string, SpaceView>, current: string | null): SpaceInventory[] {
  return after.map((space) => {
    const prior = before.find((each) => each.id === space.id);
    const view = views[space.id];
    if (!prior || !view || space.personal) return space;
    const open = openThreads(view);
    const removed = prior.threads.filter((row) => row.owner?.brain === "hosted" && !space.projects.some((project) => project.key === row.projectId));
    const unavailable = [...(prior.unavailable ?? []), ...removed.map(({ id, title, projectId }) => ({ id, title: title ?? "Thread", projectId }))].filter(
      (row) => open.has(row.id) && !space.threads.some((thread) => thread.id === row.id),
    );
    const detached = space.id === current ? retainLocal(prior, space, view, after) : undefined;
    return { ...space, unavailable, detached };
  });
}

function openThreads(view: SpaceView): Set<string> {
  const ids = new Set([...view.tabs.flatMap((tab) => (tab.route.view === "thread" ? [tab.route.threadId] : [])), ...view.panes]);
  if (view.destination.view === "thread") ids.add(view.destination.threadId);
  return ids;
}

function retainLocal(before: SpaceInventory, after: SpaceInventory, view: SpaceView, inventory: SpaceInventory[]): SpaceInventory["detached"] {
  const open = openThreads(view);
  const local = new Set(inventory.flatMap((space) => space.threads.filter((row) => row.owner?.brain !== "hosted").map((row) => row.id)));
  const detachedThreads = [...before.threads, ...(before.detached?.threads ?? [])].filter(
    (row) => open.has(row.id) && local.has(row.id) && !after.projects.some((project) => project.key === row.projectId),
  );
  const projects = new Map([...before.projects, ...(before.detached?.projects ?? [])].map((project) => [project.key, project]));
  const requested = new Set(view.tabs.flatMap((tab) => (tab.route.view === "newthread" && tab.route.projectId ? [tab.route.projectId] : [])));
  if (view.destination.view === "newthread" && view.destination.projectId) requested.add(view.destination.projectId);
  for (const row of detachedThreads) requested.add(row.projectId);
  const kept = [...projects.values()].filter((project) => project.localProjectId && requested.has(project.key) && !after.projects.some((row) => row.key === project.key));
  return kept.length ? { projects: kept, threads: [...new Map(detachedThreads.map((row) => [row.id, row])).values()] } : undefined;
}

function hasId(value: unknown, ids: Set<string>): boolean {
  if (typeof value === "string") return ids.has(value);
  if (Array.isArray(value)) return value.some((item) => hasId(item, ids));
  return Boolean(value && typeof value === "object" && Object.values(value).some((item) => hasId(item, ids)));
}

/** Cancel before removing queries so delayed pages cannot restore discarded cloud content. */
export function purgeSpaceAccess(before: SpaceInventory[], after: SpaceInventory[]): void {
  const visible = new Set(after.flatMap((space) => space.threads.map((thread) => thread.id)));
  const removed = before.flatMap((space) => space.threads.filter((row) => row.owner?.brain === "hosted" && !visible.has(row.id)).map((row) => row.id));
  const restored = before.flatMap((space) => space.unavailable?.filter((row) => visible.has(row.id)).map((row) => row.id) ?? []);
  if (!removed.length && !restored.length) return;
  const changed = [...removed, ...restored];
  const ids = new Set([...changed, ...changed.map(hostedRunId)]);
  const predicate = (query: Query) => hasId(query.queryKey[1], ids) || ["threads.list", "threads.search", "threads.resolvedCount"].includes(String(query.queryKey[0]));
  void queryClient.cancelQueries({ predicate });
  queryClient.removeQueries({ predicate });
  runs.forget(removed.map(hostedRunId));
}
