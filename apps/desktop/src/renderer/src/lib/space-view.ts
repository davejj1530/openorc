import { WORKSPACE_ID, type SpaceProject, type ThreadSummary } from "@openorc/protocol";
import { routeFromSpec, type Route } from "./router";
import type { ThreadTab } from "./thread-tabs";
import type { ChatWorkRoute } from "./team-chat-route";
import { OnlineTaskRef } from "./task-ref";
import { onlineTaskDestination } from "./online-task-route";

export interface SpaceInventory {
  id: string;
  accountId?: string;
  personal: boolean;
  projects: SpaceProject[];
  threads: (Pick<ThreadSummary, "id" | "projectId" | "owner"> & Partial<Pick<ThreadSummary, "title">>)[];
  unavailable?: { id: string; title: string; projectId: string }[];
  detached?: { projects: SpaceProject[]; threads: SpaceInventory["threads"] };
  taskIds: string[];
  /** The person is frozen out of this organization: its identity stays, and nothing of its content is held. */
  closed?: boolean;
}

export const closedSpace = (space: Pick<SpaceInventory, "id" | "accountId">): SpaceInventory => ({
  id: space.id,
  ...(space.accountId !== undefined && { accountId: space.accountId }),
  personal: false,
  projects: [],
  threads: [],
  taskIds: [],
  closed: true,
});

/** A successful scoped read or start can discover work before the next full catalog reconciliation. */
export function observeSpaceThreads(inventory: SpaceInventory[], spaceId: string, rows: SpaceInventory["threads"]): SpaceInventory[] {
  let changed = false;
  const next = inventory.map((space) => {
    if (space.closed) return space;
    const visible = rows.filter((row) => (row.owner?.brain !== "hosted" || space.id === spaceId) && hasListedProject(row.projectId, space));
    const threads = observedThreads(space.threads, visible);
    const detached = space.detached;
    const local = detached
      ? observedThreads(
          detached.threads,
          rows.filter((row) => row.owner?.brain !== "hosted" && detached.projects.some((project) => project.key === row.projectId)),
        )
      : undefined;
    if (threads === space.threads && local === detached?.threads) return space;
    changed = true;
    return { ...space, threads, ...(detached && local && { detached: { ...detached, threads: local } }) };
  });
  return changed ? next : inventory;
}

function observedThreads(before: SpaceInventory["threads"], rows: SpaceInventory["threads"]): SpaceInventory["threads"] {
  const additions = rows.filter((row) => !before.some((known) => known.id === row.id && known.projectId === row.projectId && known.owner?.brain === row.owner?.brain && known.title === row.title));
  if (!additions.length) return before;
  const threads = new Map(before.map((row) => [row.id, row]));
  for (const { id, projectId, owner, title } of additions) threads.set(id, { id, projectId, owner, title });
  return [...threads.values()];
}
export interface SpaceView {
  destination: Route;
  tabs: ThreadTab[];
  activeTab: string | null;
  panes: string[];
  chatWork?: ChatWorkRoute | null;
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
const hasListedProject = (id: string, inventory: SpaceInventory) => inventory.projects.some((row) => row.key === id) || (inventory.personal && id === WORKSPACE_ID);
const hasProject = (id: string, inventory: SpaceInventory) => hasListedProject(id, inventory) || Boolean(inventory.detached?.projects.some((row) => row.key === id));
const hasThread = (id: string, inventory: SpaceInventory) => inventory.threads.some((row) => row.id === id);
const hasOpenThread = (id: string, inventory: SpaceInventory) =>
  hasThread(id, inventory) || Boolean(inventory.unavailable?.some((row) => row.id === id)) || Boolean(inventory.detached?.threads.some((row) => row.id === id));

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
    if (value["taskRef"] !== undefined) return onlineTaskRoute(value, inventory);
    return task && inventory.taskIds.includes(task) && ["chat", "spec", "files", "commits", "memory"].includes(String(value["tab"])) ? routeFromSpec(`task:${task}:${value["tab"]}`) : null;
  }
  const project = text(value["projectId"]);
  const thread = text(value["threadId"]);
  if ((project && !hasProject(project, inventory)) || (thread && !hasThread(thread, inventory))) return null;
  return { view: "newtask", ...(project && { projectId: project }), ...(thread && { threadId: thread }) };
}
function onlineTaskRoute(value: SavedRoute, inventory: SpaceInventory): Route | null {
  const parsed = OnlineTaskRef.safeParse(value["taskRef"]);
  if (!parsed.success || inventory.personal) return null;
  const ref = parsed.data;
  if (ref.id !== value["taskId"] || ref.accountId !== inventory.accountId || ref.spaceId !== inventory.id) return null;
  if (!inventory.projects.some((project) => project.hostedProjectId === ref.projectId)) return null;
  return onlineTaskDestination(ref, value["tab"]);
}
function threadRoute(value: SavedRoute, inventory: SpaceInventory): Route | null {
  const id = text(value[value["view"] === "thread" ? "threadId" : "parentId"]);
  if (!id || !(value["view"] === "thread" ? hasOpenThread(id, inventory) : hasThread(id, inventory))) return null;
  return value["view"] === "thread" ? { view: "thread", threadId: id } : { view: "newsubthread", parentId: id };
}
function peopleRoute(value: SavedRoute, inventory: SpaceInventory): Route | null {
  if (inventory.personal || value["spaceId"] !== inventory.id) return null;
  const section = value["section"];
  return { view: "people", spaceId: inventory.id, ...(section === "invitations" || section === "seats" ? { section } : {}) };
}
function chatRoute(value: SavedRoute, inventory: SpaceInventory): Route | null {
  const accountId = text(value["accountId"]);
  const conversationId = text(value["conversationId"]);
  if (inventory.personal || !accountId || accountId !== inventory.accountId || value["spaceId"] !== inventory.id || !conversationId) return null;
  return { view: "team-chat", accountId, spaceId: inventory.id, conversationId };
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
    case "team-chat":
      return chatRoute(value, inventory);
    case "tasks":
    case "pulls":
    case "memory":
    case "scheduled":
      return { view: value["view"] };
    default:
      return null;
  }
}

function savedWorkspace(value: SavedRoute, route: Route, inventory: SpaceInventory): Pick<SpaceView, "panes" | "chatWork"> {
  const suspended = route.view === "team-chat" ? destination(value["chatWork"], inventory) : null;
  const chatWork = suspended?.view === "thread" || suspended?.view === "newthread" ? suspended : null;
  const panes =
    route.view === "thread" || chatWork?.view === "thread"
      ? strings(value["panes"])
          .filter((id) => hasOpenThread(id, inventory))
          .slice(0, 3)
      : [];
  const work = route.view === "thread" ? route : chatWork;
  if (work?.view === "thread" && !panes.includes(work.threadId)) panes.unshift(work.threadId);
  return { panes: panes.slice(0, 3), ...(route.view === "team-chat" && { chatWork }) };
}

export function validSpaceView(value: unknown, inventory: SpaceInventory): SpaceView {
  if (!record(value)) return emptySpaceView();
  const route = destination(value["destination"], inventory) ?? { view: "newthread" };
  const tabs: ThreadTab[] = Array.isArray(value["tabs"])
    ? value["tabs"].flatMap((tab: unknown) => {
        if (!record(tab) || typeof tab["id"] !== "string") return [];
        const route = destination(tab["route"], inventory);
        return route && (route.view === "thread" || route.view === "newthread" || route.view === "team-chat") ? [{ id: tab["id"], route }] : [];
      })
    : [];
  const filter = record(value["filter"]) ? value["filter"] : {};
  const keys = [...inventory.projects.map((project) => project.key), ...(inventory.personal ? [WORKSPACE_ID] : [])];
  const routes = (value: unknown) => (Array.isArray(value) ? value.flatMap((item: unknown) => destination(item, inventory) ?? []).slice(-50) : []);
  return {
    destination: route,
    tabs,
    activeTab: tabs.find((tab) => tab.id === value["activeTab"])?.id ?? tabs[0]?.id ?? null,
    ...savedWorkspace(value, route, inventory),
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
