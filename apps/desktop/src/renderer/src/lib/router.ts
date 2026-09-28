import { create } from "zustand";
import { useLayout } from "./layout";

export type TaskTab = "chat" | "spec" | "files" | "commits" | "memory";

export type Route =
  | { view: "onboarding"; mode?: "first_run" | "recovery"; preview?: boolean }
  | { view: "newthread"; projectId?: string }
  | { view: "newtask"; projectId?: string; threadId?: string }
  | { view: "thread"; threadId: string }
  | { view: "inbox" }
  | { view: "tasks" }
  | { view: "project"; projectId: string }
  | { view: "task"; taskId: string; tab: TaskTab }
  | { view: "memory" }
  | { view: "scheduled" }
  | { view: "orchestration"; projectId?: string; teamId?: string }
  | { view: "settings"; section?: "usage" | "connections" | "general"; provider?: "codex" | "claude" }
  | { view: "diagnostics" };

interface RouterState {
  route: Route;
  /** Visible threads in visual order. The route identifies the focused pane. */
  threadIds: string[];
  addThreadPane: (id: string) => void;
  closeThreadPane: (id: string) => void;
  focusThreadPane: (id: string) => void;
  closeOtherThreadPanes: () => void;
  history: Route[];
  future: Route[];
  navigate: (route: Route) => void;
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
  const applyRoute = (route: Route) => {
    const threadIds = panesForRoute(get(), route);
    if (get().route.view === "thread" || route.view === "thread") reconcilePanel(threadIds, route.view === "thread" ? route.threadId : null);
    return { route, threadIds };
  };
  return {
    route: { view: "newthread" },
    threadIds: [],
    history: [],
    future: [],
    navigate: (route) => set({ ...applyRoute(route), history: [...get().history.slice(-49), get().route], future: [] }),
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

export function openTask(taskId: string, tab: TaskTab = "spec"): void {
  useRouter.getState().navigate({ view: "task", taskId, tab });
}

export function openThread(threadId: string): void {
  useRouter.getState().navigate({ view: "thread", threadId });
}

/** "thread:<id>", "task:<id>:<tab>", or a plain screen name, as windows and autorun pass them. */
export function routeFromSpec(spec: string): Route | null {
  const [view, id, tab] = spec.split(":");
  if (view === "onboarding")
    return {
      view,
      ...(id === "recovery" ? { mode: "recovery" as const } : {}),
      ...(id === "preview" || tab === "preview" ? { preview: true } : {}),
    };
  if (view === "thread" && id) return { view: "thread", threadId: id };
  if (view === "newtask") return { view: "newtask", ...(id ? { projectId: id } : {}) };
  if (view === "task" && id)
    return {
      view: "task",
      taskId: id,
      tab: (tab as TaskTab | undefined) ?? "spec",
    };
  if (view === "project" && id) return { view: "project", projectId: id };
  if (view === "orchestration")
    return {
      view,
      ...(id ? { projectId: id } : {}),
      ...(tab ? { teamId: tab } : {}),
    };
  if (view === "settings")
    return {
      view,
      ...(id === "usage" ? { section: "usage" as const, ...(tab === "codex" || tab === "claude" ? { provider: tab } : {}) } : {}),
      ...(id === "general" ? { section: "general" as const } : {}),
    };
  if (view === "inbox" || view === "tasks" || view === "memory" || view === "scheduled" || view === "diagnostics" || view === "newthread") return { view };
  return null;
}

export function specFromRoute(route: Route): string {
  switch (route.view) {
    case "settings":
      return route.section ? `settings:${route.section}${route.provider ? `:${route.provider}` : ""}` : "settings";
    case "onboarding":
      return ["onboarding", route.mode === "recovery" ? "recovery" : null, route.preview ? "preview" : null].filter(Boolean).join(":");
    case "thread":
      return `thread:${route.threadId}`;
    case "task":
      return `task:${route.taskId}:${route.tab}`;
    case "project":
      return `project:${route.projectId}`;
    case "newtask":
      return `newtask${route.projectId ? `:${route.projectId}` : ""}`;
    case "orchestration":
      return `orchestration${route.projectId ? `:${route.projectId}${route.teamId ? `:${route.teamId}` : ""}` : ""}`;
    default:
      return route.view;
  }
}

export function newThread(projectId?: string): void {
  useRouter.getState().navigate({ view: "newthread", ...(projectId ? { projectId } : {}) });
}
