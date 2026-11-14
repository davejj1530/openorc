import { create } from "zustand";
import { PANE_MS, prefersReducedMotion } from "./motion";
import { useRouter, type Route } from "./router";
import { movedBefore } from "./tab-order";
import { navigationScope } from "./navigation-scope";
import { pristineNewThread } from "./new-thread-preparation";

/** Work and organization conversations share a strip, with separate identities. */
export type TabRoute = Extract<Route, { view: "thread" | "newthread" | "team-chat" }>;

export interface ThreadTab {
  id: string;
  route: TabRoute;
}

interface ThreadTabsState {
  tabs: ThreadTab[];
  active: string | null;
  /** Closed tabs folding away: still drawn, never chosen, reused or saved, and gone once the fold ends. */
  leaving: string[];
  select: (id: string) => void;
  open: (projectId?: string) => void;
  /** A thread in a tab of its own, or the tab that already holds it. */
  openThread: (threadId: string) => void;
  close: (id: string) => void;
  /** Puts a tab ahead of another, or last. */
  reorder: (id: string, beforeId: string | null) => void;
}

const KEY = "openorc.threadTabs";

const isTabRoute = (route: Route): route is TabRoute => route.view === "thread" || route.view === "newthread" || route.view === "team-chat";
const newTab = (route: TabRoute): ThreadTab => ({ id: crypto.randomUUID(), route });

function saved(): Pick<ThreadTabsState, "tabs" | "active"> {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null") as Pick<ThreadTabsState, "tabs" | "active"> | null;
    if (value && Array.isArray(value.tabs)) return { tabs: value.tabs.filter((tab) => tab && isTabRoute(tab.route) && tab.route.view !== "team-chat"), active: value.active };
  } catch {
    // A tab list that cannot be read starts over.
  }
  return { tabs: [], active: null };
}

/** How long a closed tab takes to fold away: the shape-resize duration, or at once under reduced motion. */
const foldMs = () => (typeof window.matchMedia === "function" && prefersReducedMotion() ? 0 : PANE_MS);

function sameRoute(a: TabRoute, b: TabRoute): boolean {
  if (a.view === "thread") return b.view === "thread" && a.threadId === b.threadId;
  if (a.view === "newthread") return b.view === "newthread" && a.projectId === b.projectId;
  return b.view === "team-chat" && a.accountId === b.accountId && a.spaceId === b.spaceId && a.conversationId === b.conversationId;
}

/**
 * The work column's tabs, like a browser's: each holds a thread or a new thread. Going to a thread switches to its tab
 * when one holds it and otherwise opens it in the current tab; + opens a new thread in a tab of its own, or brings back
 * the project's new thread when a tab already holds it. Switching tabs shows the tab's thread alone and adds no history.
 */
export const useThreadTabs = create<ThreadTabsState>((set, get) => ({
  ...saved(),
  leaving: [],
  select: (id) => {
    const tab = get().tabs.find((each) => each.id === id);
    if (!tab || get().leaving.includes(id)) return;
    set({ active: id });
    useRouter.getState().show(tab.route);
  },
  open: (projectId) => {
    const route: TabRoute = { view: "newthread", ...(projectId ? { projectId } : {}) };
    const holding = staying(get()).find((tab) => sameRoute(tab.route, route));
    if (holding) return get().select(holding.id);
    const tab = newTab(route);
    set({ tabs: [...get().tabs, tab], active: tab.id });
    useRouter.getState().show(tab.route);
  },
  openThread: (threadId) => {
    const holding = staying(get()).find((tab) => tab.route.view === "thread" && tab.route.threadId === threadId);
    if (holding) return get().select(holding.id);
    const tab = newTab({ view: "thread", threadId });
    set({ tabs: [...get().tabs, tab], active: tab.id });
    useRouter.getState().show(tab.route);
  },
  /**
   * Folds a tab away. The current one hands over at once to its nearest tab on the left, else on the right, else to a
   * new thread, so the column moves on while the tab folds; it leaves the list once the fold ends.
   */
  close: (id) => {
    const state = get();
    const at = state.tabs.findIndex((tab) => tab.id === id);
    if (at < 0 || state.leaving.includes(id)) return;
    const rest = staying(state).filter((tab) => tab.id !== id);
    const gone = () => set((now) => ({ tabs: now.tabs.filter((tab) => tab.id !== id), leaving: now.leaving.filter((each) => each !== id) }));
    setTimeout(gone, foldMs());
    if (state.active !== id) return set({ leaving: [...state.leaving, id] });
    const next = rest.filter((tab) => state.tabs.indexOf(tab) < at).at(-1) ?? rest[0] ?? newTab({ view: "newthread" });
    set({ tabs: rest.includes(next) ? state.tabs : [...state.tabs, next], active: next.id, leaving: [...state.leaving, id] });
    useRouter.getState().show(next.route);
  },
  reorder: (id, beforeId) => set({ tabs: movedBefore(get().tabs, id, beforeId) }),
}));

/** The tabs that are not folding away. */
function staying({ tabs, leaving }: Pick<ThreadTabsState, "tabs" | "leaving">): ThreadTab[] {
  return leaving.length ? tabs.filter((tab) => !leaving.includes(tab.id)) : tabs;
}

/**
 * The current tab follows wherever the work column goes, and a route another tab holds brings that tab forward, so
 * Back and Forward move between tabs rather than writing one tab's place into another. In a split the tab holds the
 * leftmost pane's thread; focusing another pane leaves it be.
 */
function follow(route: Route): void {
  if (navigationScope.restoring) return;
  if (!isTabRoute(route)) return;
  const { threadIds } = useRouter.getState();
  const shown: TabRoute = route.view === "thread" && threadIds.length > 1 ? { view: "thread", threadId: threadIds[0]! } : route;
  const state = useThreadTabs.getState();
  const { tabs, active } = state;
  const holding = staying(state).find((tab) => sameRoute(tab.route, shown));
  if (holding) return void useThreadTabs.setState({ active: holding.id, tabs: tabs.map((tab) => (tab.id === holding.id ? { ...tab, route: shown } : tab)) });
  const current = tabs.find((tab) => tab.id === active);
  if (!current || needsOwnTab(current.route, shown)) {
    const tab = newTab(shown);
    return void useThreadTabs.setState({ tabs: [...tabs, tab], active: tab.id });
  }
  useThreadTabs.setState({ tabs: tabs.map((tab) => (tab.id === active ? { ...tab, route: shown } : tab)) });
}

function needsOwnTab(current: TabRoute, next: TabRoute): boolean {
  if (current.view === "team-chat") return true;
  return next.view === "team-chat" && !(current.view === "newthread" && pristineNewThread(current.projectId));
}

// The tabs saved from last time come back with the one that was open; with none, the first tab holds where the app opens.
const restored = useThreadTabs.getState().tabs.find((tab) => tab.id === useThreadTabs.getState().active);
if (restored) useRouter.getState().show(restored.route);
else follow(useRouter.getState().route);
useRouter.subscribe((state, previous) => {
  if (state.route !== previous.route || state.threadIds !== previous.threadIds) follow(state.route);
});
useThreadTabs.subscribe((state) => {
  if (navigationScope.active) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ tabs: staying(state).filter((tab) => tab.route.view !== "team-chat"), active: state.active }));
  } catch {
    // Tabs are a convenience; one that cannot be saved is rebuilt from where the column goes.
  }
});
