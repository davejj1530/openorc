import { create } from "zustand";
import type { HarnessId } from "@openorc/protocol";
import { useLayout } from "./layout";
import { chatRouteFromSpec, chatRouteSpec, chatRouteTransition, type ChatWorkRoute, type TeamChatRoute } from "./team-chat-route";
import type { OnlineTaskRef } from "./task-ref";
import { onlineTaskRouteFromSpec, onlineTaskRouteSpec } from "./online-task-route";

export type TaskTab = "chat" | "spec" | "files" | "commits" | "memory";

/** A message to bring into view: its run, the turn of that run it falls in, and its id. */
/** A message to open a conversation at; with `note`, a teammate's note in a cloud thread, by its id. */
export type MessageTarget = { runId: string; turn: number; messageId: string; note?: true };

/** The sections Settings is divided into, in the order it lists them. */
export const SETTINGS_SECTIONS = ["usage", "connections", "account", "cloud", "slack", "phone", "skills", "connectors", "devices", "appearance", "general", "memory", "data"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
const settingsSections: ReadonlySet<string> = new Set<SettingsSection>(SETTINGS_SECTIONS);

export type Route =
  | TeamChatRoute
  | { view: "onboarding"; mode?: "first_run" | "recovery"; preview?: boolean }
  | { view: "newthread"; projectId?: string }
  /** A new thread under `parentId`, working in its folder. */
  | { view: "newsubthread"; parentId: string }
  | { view: "newtask"; projectId?: string; threadId?: string }
  /** A conversation, optionally with a message to bring into view there, such as a search result. */
  | { view: "thread"; threadId: string; message?: MessageTarget }
  | { view: "tasks" }
  | { view: "pulls" }
  | { view: "people"; spaceId: string; section?: "invitations" | "seats" }
  | { view: "pull"; projectId: string; number: number }
  /** A project's settings. */
  | { view: "project"; projectId: string }
  | { view: "task"; taskId: string; taskRef?: OnlineTaskRef; tab: TaskTab; message?: MessageTarget }
  | { view: "memory" }
  | { view: "scheduled" }
  /** The Orcling designer: a new Orcling, or one being changed. */
  | { view: "orcling"; orclingId?: string }
  /** A section, optionally with what to bring into view there: a provider's usage, or a project to add to OpenOrc Cloud. */
  | { view: "settings"; section?: SettingsSection; provider?: HarnessId; project?: string }
  | { view: "diagnostics" };

interface RouterState {
  route: Route;
  /** Visible threads in visual order. The route identifies the focused pane. */
  threadIds: string[];
  chatWork: ChatWorkRoute | null;
  addThreadPane: (id: string) => void;
  closeThreadPane: (id: string) => void;
  focusThreadPane: (id: string) => void;
  closeOtherThreadPanes: () => void;
  history: Route[];
  future: Route[];
  navigate: (route: Route) => void;
  /** A route alone in the window with no history entry: switching tabs is not a step to go back over. */
  show: (route: Route) => void;
  back: () => void;
  forward: () => void;
}

export const MAX_THREAD_PANES = 3;

/** Navigation replaces the focused pane, or focuses an already visible thread. */
function panesForRoute(state: RouterState, route: Route): string[] {
  if (route.view !== "thread") return [];
  if (state.route.view !== "thread" || !state.threadIds.length) return [route.threadId];
  if (state.threadIds.includes(route.threadId)) return state.threadIds;
  const focused = state.route.threadId;
  return state.threadIds.map((id) => (id === focused ? route.threadId : id));
}

function reconcilePanel(ids: string[], focused: string | null, closeRemoved = false): void {
  const layout = useLayout.getState();
  if (layout.panelThreadId && ids.includes(layout.panelThreadId)) return;
  useLayout.setState({ panelThreadId: focused, selectedFile: null, selectedChanges: null });
  if (closeRemoved) layout.setPanel(false);
}

/** Routes and visible panes change together, including history navigation. */
export const useRouter = create<RouterState>((set, get) => {
  const applyRoute = (route: Route, alone = false) => {
    const chat = chatRouteTransition(get(), route);
    if (chat) return chat;
    let threadIds = panesForRoute(get(), route);
    if (alone) threadIds = route.view === "thread" ? [route.threadId] : [];
    if (get().route.view === "thread" || get().chatWork?.view === "thread" || route.view === "thread") reconcilePanel(threadIds, route.view === "thread" ? route.threadId : null);
    return { route, threadIds, chatWork: null };
  };
  return {
    route: { view: "newthread" },
    threadIds: [],
    chatWork: null,
    history: [],
    future: [],
    navigate: (route) => set({ ...applyRoute(route), history: [...get().history.slice(-49), get().route], future: [] }),
    show: (route) => set(applyRoute(route, true)),
    back: () => {
      const { history: h, future, route } = get();
      const prev = h[h.length - 1];
      if (prev) set({ ...applyRoute(prev), history: h.slice(0, -1), future: [route, ...future].slice(0, 50) });
    },
    forward: () => {
      const { history: h, future, route } = get();
      const next = future[0];
      if (next) set({ ...applyRoute(next), history: [...h, route], future: future.slice(1) });
    },
    addThreadPane: (id) => {
      const s = get();
      if (!id || s.threadIds.includes(id) || s.threadIds.length >= MAX_THREAD_PANES) return;
      if (s.route.view !== "thread") {
        s.navigate({ view: "thread", threadId: id });
        return;
      }
      set({ threadIds: [...s.threadIds, id] });
    },
    focusThreadPane: (id) => {
      if (get().threadIds.includes(id)) set({ route: { view: "thread", threadId: id } });
    },
    closeThreadPane: (id) => {
      const s = get();
      if (!s.threadIds.includes(id)) return;
      const threadIds = s.threadIds.filter((t) => t !== id);
      const focused = s.route.view === "thread" && s.route.threadId !== id ? s.route.threadId : (threadIds[Math.max(0, s.threadIds.indexOf(id) - 1)] ?? null);
      reconcilePanel(threadIds, focused, true);
      set({ threadIds, route: focused ? { view: "thread", threadId: focused } : { view: "newthread" } });
    },
    closeOtherThreadPanes: () => {
      const s = get();
      if (s.route.view !== "thread") return;
      const threadIds = [s.route.threadId];
      reconcilePanel(threadIds, s.route.threadId, true);
      set({ threadIds });
    },
  };
});

export function openTask(taskId: string, tab: TaskTab = "spec", message?: MessageTarget): void {
  useRouter.getState().navigate({ view: "task", taskId, tab, ...(message ? { message } : {}) });
}

/** A project's settings: its worktree setup, Claude accounts and the rest. Its tasks are the Tasks screen's, under the sidebar's filter. */
export function openProject(projectId: string): void {
  useRouter.getState().navigate({ view: "project", projectId });
}

export function openPullRequest(projectId: string, number: number): void {
  useRouter.getState().navigate({ view: "pull", projectId, number });
}

export function openThread(threadId: string, message?: MessageTarget): void {
  useRouter.getState().navigate({ view: "thread", threadId, ...(message ? { message } : {}) });
}

/** Screens a spec names without an id. */
type PlainView = "tasks" | "pulls" | "memory" | "scheduled" | "diagnostics" | "newthread";
const plainViews: ReadonlySet<string> = new Set<PlainView>(["tasks", "pulls", "memory", "scheduled", "diagnostics", "newthread"]);

function isPlainView(view: string | undefined): view is PlainView {
  return view !== undefined && plainViews.has(view);
}

/** Screens a spec names by one id. */
const idViews: Readonly<Record<string, (id: string, tab: string | undefined) => Route>> = {
  thread: (threadId) => ({ view: "thread", threadId }),
  people: (spaceId, section) => ({ view: "people", spaceId, ...(section === "invitations" || section === "seats" ? { section } : {}) }),
  project: (projectId) => ({ view: "project", projectId }),
  newsubthread: (parentId) => ({ view: "newsubthread", parentId }),
};
const scopedViews = new Map<string, (spec: string) => Route | null>([
  ["team-chat", chatRouteFromSpec],
  ["online-task", onlineTaskRouteFromSpec],
]);

/** "thread:<id>", "task:<id>:<tab>", "pull:<project>:<number>", or a plain screen name, as windows and autorun pass them. */
export function routeFromSpec(spec: string): Route | null {
  const scoped = scopedViews.get(spec.slice(0, spec.indexOf(":")));
  if (scoped) return scoped(spec);
  const [view, id, tab] = spec.split(":");
  if (view === "onboarding")
    return {
      view,
      ...(id === "recovery" ? { mode: "recovery" as const } : {}),
      ...(id === "preview" || tab === "preview" ? { preview: true } : {}),
    };
  if (view && id && Object.hasOwn(idViews, view)) return idViews[view]!(id, tab);
  if (view === "newtask") return { view: "newtask", ...(id ? { projectId: id } : {}) };
  if (view === "task" && id)
    return {
      view: "task",
      taskId: id,
      tab: (tab as TaskTab | undefined) ?? "spec",
    };
  if (view === "pull" && id && Number(tab) > 0) return { view: "pull", projectId: id, number: Number(tab) };

  if (view === "settings") return settingsFromSpec(id, tab);
  if (isPlainView(view)) return { view };
  return null;
}

function isSettingsSection(value: string | undefined): value is SettingsSection {
  return value !== undefined && settingsSections.has(value);
}

/** "settings:<section>", with a provider after usage or a project after cloud. */
function settingsFromSpec(section: string | undefined, detail: string | undefined): Route {
  if (!isSettingsSection(section)) return { view: "settings" };
  if (section === "usage" && (detail === "codex" || detail === "claude")) return { view: "settings", section, provider: detail };
  if (section === "cloud" && detail) return { view: "settings", section, project: detail };
  return { view: "settings", section };
}

function settingsSpec(route: Extract<Route, { view: "settings" }>): string {
  return route.section ? ["settings", route.section, route.provider ?? route.project].filter(Boolean).join(":") : "settings";
}

function onboardingSpec(route: Extract<Route, { view: "onboarding" }>): string {
  return ["onboarding", route.mode === "recovery" ? "recovery" : null, route.preview ? "preview" : null].filter(Boolean).join(":");
}

export function specFromRoute(route: Route): string {
  switch (route.view) {
    case "team-chat":
      return chatRouteSpec(route);
    case "settings":
      return settingsSpec(route);
    case "onboarding":
      return onboardingSpec(route);
    case "thread":
      return `thread:${route.threadId}`;
    case "task":
      return route.taskRef ? onlineTaskRouteSpec(route.taskRef, route.tab) : `task:${route.taskId}:${route.tab}`;
    case "project":
      return `project:${route.projectId}`;
    case "people":
      return `people:${route.spaceId}${route.section ? `:${route.section}` : ""}`;
    case "pull":
      return `pull:${route.projectId}:${route.number}`;
    case "newtask":
      return `newtask${route.projectId ? `:${route.projectId}` : ""}`;
    case "newsubthread":
      return `newsubthread:${route.parentId}`;
    default:
      return route.view;
  }
}

export function newSubthread(parentId: string): void {
  useRouter.getState().navigate({ view: "newsubthread", parentId });
}

export function newThread(projectId?: string): void {
  useRouter.getState().navigate({ view: "newthread", ...(projectId ? { projectId } : {}) });
}

/** Leaves Settings for the screen it was opened from, or a new thread when Settings was the first screen. */
export function closeSettings(): void {
  const { history, navigate } = useRouter.getState();
  navigate(history.findLast((entry) => entry.view !== "settings") ?? { view: "newthread" });
}
