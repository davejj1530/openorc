import { WORKSPACE_ID, type SpaceProject, type ThreadSummary } from "@openorc/protocol";
import { routeFromSpec, type Route } from "./router";
import type { ThreadTab } from "./thread-tabs";

export interface SpaceInventory {
  id: string;
  personal: boolean;
  projects: SpaceProject[];
  threads: Pick<ThreadSummary, "id" | "projectId" | "owner">[];
  taskIds: string[];
}

/** A successful scoped read or start can discover work before the next full catalog reconciliation. */
export function observeSpaceThreads(inventory: SpaceInventory[], spaceId: string, rows: SpaceInventory["threads"]): SpaceInventory[] {
  let changed = false;
  const next = inventory.map((space) => {
    const visible = rows.filter((row) => (row.owner?.brain !== "hosted" || space.id === spaceId) && hasProject(row.projectId, space));
    const additions = visible.filter((row) => !space.threads.some((known) => known.id === row.id && known.projectId === row.projectId && known.owner?.brain === row.owner?.brain));
    if (!additions.length) return space;
    changed = true;
    const threads = new Map(space.threads.map((row) => [row.id, row]));
    for (const { id, projectId, owner } of additions) threads.set(id, { id, projectId, owner });
    return { ...space, threads: [...threads.values()] };
  });
  return changed ? next : inventory;
}
export interface SpaceView {
  destination: Route;
  tabs: ThreadTab[];
  activeTab: string | null;
  panes: string[];
  filter: { ownership: "mine" | "everyone"; pinnedOnly: boolean; hiddenProjectKeys: string[]; project: string };
  history: Route[];
  future: Route[];
}

export const emptySpaceView = (): SpaceView => ({
  destination: { view: "newthread" },
  tabs: [],
  activeTab: null,
  panes: [],
  filter: { ownership: "everyone", pinnedOnly: false, hiddenProjectKeys: [], project: "all" },
  history: [],
  future: [],
});

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);

type SavedRoute = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value : null);
const hasProject = (id: string, inventory: SpaceInventory) => inventory.projects.some((row) => row.key === id) || (inventory.personal && id === WORKSPACE_ID);
const hasThread = (id: string, inventory: SpaceInventory) => inventory.threads.some((row) => row.id === id);

function projectRoute(value: SavedRoute, inventory: SpaceInventory): Route | null {
  const view = value["view"];
  const project = text(value["projectId"]);
  if (project && !hasProject(project, inventory)) return null;
  if (view === "newthread") return project ? { view, projectId: project } : { view };
  if (!project) return null;
  if (view === "project") return { view, projectId: project };
  const number = value["number"];
  return typeof number === "number" && Number.isInteger(number) && number > 0 ? { view: "pull", projectId: project, number } : null;
}
function taskRoute(value: SavedRoute, inventory: SpaceInventory): Route | null {
  if (value["view"] === "task") {
    const task = text(value["taskId"]);
    return task && inventory.taskIds.includes(task) && ["chat", "spec", "files", "commits", "memory"].includes(String(value["tab"])) ? routeFromSpec(`task:${task}:${value["tab"]}`) : null;
  }
  const project = text(value["projectId"]);
  const thread = text(value["threadId"]);
  if ((project && !hasProject(project, inventory)) || (thread && !hasThread(thread, inventory))) return null;
  return { view: "newtask", ...(project && { projectId: project }), ...(thread && { threadId: thread }) };
}
function threadRoute(value: SavedRoute, inventory: SpaceInventory): Route | null {
  const id = text(value[value["view"] === "thread" ? "threadId" : "parentId"]);
  if (!id || !hasThread(id, inventory)) return null;
  return value["view"] === "thread" ? { view: "thread", threadId: id } : { view: "newsubthread", parentId: id };
}
function peopleRoute(value: SavedRoute, inventory: SpaceInventory): Route | null {
  if (inventory.personal || value["spaceId"] !== inventory.id) return null;
  return { view: "people", spaceId: inventory.id, ...(value["section"] === "invitations" ? { section: "invitations" } : {}) };
}

/** Saved routes are reconstructed from known fields, then checked against the current accessible catalog. */
function destination(value: unknown, inventory: SpaceInventory): Route | null {
  if (!record(value)) return null;
  switch (value["view"]) {
    case "thread":
    case "newsubthread":
      return threadRoute(value, inventory);
    case "newthread":
    case "project":
    case "pull":
      return projectRoute(value, inventory);
    case "task":
    case "newtask":
      return taskRoute(value, inventory);
    case "people":
      return peopleRoute(value, inventory);
    case "tasks":
    case "pulls":
    case "memory":
    case "scheduled":
      return { view: value["view"] };
    default:
      return null;
  }
}

export function validSpaceView(value: unknown, inventory: SpaceInventory): SpaceView {
  if (!record(value)) return emptySpaceView();
  const route = destination(value["destination"], inventory) ?? { view: "newthread" };
  const tabs: ThreadTab[] = Array.isArray(value["tabs"])
    ? value["tabs"].flatMap((tab: unknown) => {
        if (!record(tab) || typeof tab["id"] !== "string") return [];
        const route = destination(tab["route"], inventory);
        return route && (route.view === "thread" || route.view === "newthread") ? [{ id: tab["id"], route }] : [];
      })
    : [];
  const filter = record(value["filter"]) ? value["filter"] : {};
  const keys = [...inventory.projects.map((project) => project.key), ...(inventory.personal ? [WORKSPACE_ID] : [])];
  const routes = (value: unknown) => (Array.isArray(value) ? value.flatMap((item: unknown) => destination(item, inventory) ?? []).slice(-50) : []);
  const panes =
    route.view === "thread"
      ? strings(value["panes"])
          .filter((id) => inventory.threads.some((row) => row.id === id))
          .slice(0, 3)
      : [];
  if (route.view === "thread" && !panes.includes(route.threadId)) panes.unshift(route.threadId);
  return {
    destination: route,
    tabs,
    activeTab: tabs.find((tab) => tab.id === value["activeTab"])?.id ?? tabs[0]?.id ?? null,
    panes: panes.slice(0, 3),
    filter: {
      ownership: filter["ownership"] === "mine" ? "mine" : "everyone",
      pinnedOnly: filter["pinnedOnly"] === true,
      hiddenProjectKeys: strings(filter["hiddenProjectKeys"]).filter((key) => keys.includes(key)),
      project: typeof filter["project"] === "string" && keys.includes(filter["project"]) ? filter["project"] : "all",
    },
    history: routes(value["history"]),
    future: routes(value["future"]),
  };
}

export function readSpaceRecord(storage: Pick<Storage, "getItem">, key: string): { last: string | null; views: Record<string, unknown> } {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? "null");
    if (record(value)) return { last: typeof value["last"] === "string" ? value["last"] : null, views: record(value["views"]) ? value["views"] : {} };
  } catch {
    /* A broken cache starts at New thread. */
  }
  return { last: null, views: {} };
}
