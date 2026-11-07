import { create } from "zustand";
import { useRouter, type Route } from "./router";

/** What a tab holds: a thread, or a new thread being written. */
export type TabRoute = Extract<Route, { view: "thread" } | { view: "newthread" }>;

export interface ThreadTab {
  id: string;
  route: TabRoute;
}

interface ThreadTabsState {
  tabs: ThreadTab[];
  active: string | null;
  select: (id: string) => void;
  open: (projectId?: string) => void;
  /** A thread in a tab of its own, or the tab that already holds it. */
  openThread: (threadId: string) => void;
  close: (id: string) => void;
}

const KEY = "openorc.threadTabs";

const isTabRoute = (route: Route): route is TabRoute => route.view === "thread" || route.view === "newthread";
const newTab = (route: TabRoute): ThreadTab => ({ id: crypto.randomUUID(), route });

function saved(): Pick<ThreadTabsState, "tabs" | "active"> {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null") as Pick<ThreadTabsState, "tabs" | "active"> | null;
    if (value && Array.isArray(value.tabs)) return { tabs: value.tabs.filter((tab) => tab && isTabRoute(tab.route)), active: value.active };
  } catch {
    // A tab list that cannot be read starts over.
  }
  return { tabs: [], active: null };
}

const sameRoute = (a: TabRoute, b: TabRoute) => (a.view === "thread" ? b.view === "thread" && a.threadId === b.threadId : b.view === "newthread" && a.projectId === b.projectId);

/**
 * The work column's tabs, like a browser's: each holds a thread or a new thread. Going to a thread switches to its tab
 * when one holds it and otherwise opens it in the current tab; + opens a new thread in a tab of its own, or brings back
 * the project's new thread when a tab already holds it. Switching tabs shows the tab's thread alone and adds no history.
 */
export const useThreadTabs = create<ThreadTabsState>((set, get) => ({
  ...saved(),
  select: (id) => {
    const tab = get().tabs.find((each) => each.id === id);
    if (!tab) return;
    set({ active: id });
    useRouter.getState().show(tab.route);
  },
  open: (projectId) => {
    const route: TabRoute = { view: "newthread", ...(projectId ? { projectId } : {}) };
    const holding = get().tabs.find((tab) => sameRoute(tab.route, route));
    if (holding) return get().select(holding.id);
    const tab = newTab(route);
    set({ tabs: [...get().tabs, tab], active: tab.id });
    useRouter.getState().show(tab.route);
  },
  openThread: (threadId) => {
    const holding = get().tabs.find((tab) => tab.route.view === "thread" && tab.route.threadId === threadId);
    if (holding) return get().select(holding.id);
    const tab = newTab({ view: "thread", threadId });
    set({ tabs: [...get().tabs, tab], active: tab.id });
    useRouter.getState().show(tab.route);
  },
  close: (id) => {
    const { tabs, active } = get();
    const at = tabs.findIndex((tab) => tab.id === id);
    if (at < 0) return;
    const rest = tabs.filter((tab) => tab.id !== id);
    if (active !== id) return set({ tabs: rest });
    const next = rest[Math.max(0, at - 1)] ?? newTab({ view: "newthread" });
    set({ tabs: rest.length ? rest : [next], active: next.id });
    useRouter.getState().show(next.route);
  },
}));

/**
 * The current tab follows wherever the work column goes, and a route another tab holds brings that tab forward, so
 * Back and Forward move between tabs rather than writing one tab's place into another. In a split the tab holds the
 * leftmost pane's thread; focusing another pane leaves it be.
 */
function follow(route: Route): void {
  if (!isTabRoute(route)) return;
  const { threadIds } = useRouter.getState();
  const shown: TabRoute = route.view === "thread" && threadIds.length > 1 ? { view: "thread", threadId: threadIds[0]! } : route;
  const { tabs, active } = useThreadTabs.getState();
  const holding = tabs.find((tab) => sameRoute(tab.route, shown));
  if (holding) return void useThreadTabs.setState({ active: holding.id, tabs: tabs.map((tab) => (tab.id === holding.id ? { ...tab, route: shown } : tab)) });
  if (!tabs.some((tab) => tab.id === active)) {
    const tab = newTab(shown);
    return void useThreadTabs.setState({ tabs: [...tabs, tab], active: tab.id });
  }
  useThreadTabs.setState({ tabs: tabs.map((tab) => (tab.id === active ? { ...tab, route: shown } : tab)) });
}

// The tabs saved from last time come back with the one that was open; with none, the first tab holds where the app opens.
const restored = useThreadTabs.getState().tabs.find((tab) => tab.id === useThreadTabs.getState().active);
if (restored) useRouter.getState().show(restored.route);
else follow(useRouter.getState().route);
useRouter.subscribe((state, previous) => {
  if (state.route !== previous.route || state.threadIds !== previous.threadIds) follow(state.route);
});
useThreadTabs.subscribe(({ tabs, active }) => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ tabs, active }));
  } catch {
    // Tabs are a convenience; one that cannot be saved is rebuilt from where the column goes.
  }
});
