import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { unstable_batchedUpdates } from "react-dom";
import { useRouter } from "./router";
import { useThreadTabs } from "./thread-tabs";
import { useLayout } from "./layout";
import { useUi } from "./ui";
import { navigationScope } from "./navigation-scope";
import { globalDestination } from "./global-navigation";
import { retainUnavailable } from "./space-access";
import { emptySpaceView, observeSpaceThreads, readSpaceRecord, validSpaceView, type SpaceInventory, type SpaceView } from "./space-view";

interface Dependencies {
  durable: Pick<Storage, "getItem" | "setItem">;
  session: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  capture(ownership: SpaceView["filter"]["ownership"]): SpaceView;
  restore(view: SpaceView): void;
  global?(route: SpaceView["destination"]): boolean;
}
interface Navigation {
  key: string | null;
  current: string | null;
  personal: string | null;
  inventory: SpaceInventory[];
  views: Record<string, SpaceView>;
  ownership: "mine" | "everyone";
  generation: number;
  initialize(key: string, personal: string, inventory: SpaceInventory[]): void;
  select(id: string): void;
  remember(): void;
  setOwnership(ownership: "mine" | "everyone"): void;
  reconcile(inventory: SpaceInventory[]): void;
  observe(spaceId: string, rows: SpaceInventory["threads"], key: string | null): void;
  end(): void;
}

/** A window keeps its live choice. Durable writes merge other windows' last saved spaces. */
export function createSpaceNavigation(deps: Dependencies) {
  let restoring = false;
  let localView: SpaceView | null = null;
  const store = createStore<Navigation>((set, get) => {
    const save = (id: string, view: SpaceView) => saveSpaceView(deps, get().key, id, view);
    const restore = (id: string, view: SpaceView) => {
      restoring = true;
      unstable_batchedUpdates(() => {
        deps.restore(view);
        set({ current: id, ownership: view.filter.ownership, views: { ...get().views, [id]: view }, generation: get().generation + 1 });
      });
      restoring = false;
      save(id, view);
    };
    return {
      key: null,
      current: null,
      personal: null,
      inventory: [],
      views: {},
      ownership: "everyone",
      generation: 0,
      initialize(key, personal, inventory) {
        if (get().key === key) return get().reconcile(inventory);
        const old = deps.capture("everyone");
        localView ??= old;
        const saved = readSpaceRecord(deps.durable, key);
        if (!get().key && !saved.views[personal]) inventory = retainInitialLocal(inventory, personal, old);
        const views = Object.fromEntries(inventory.map((space) => [space.id, validSpaceView(saved.views[space.id] ?? (get().key ? null : old), space)]));
        let wanted = saved.last;
        try {
          wanted = deps.session.getItem(key) ?? wanted;
        } catch {
          /* Use the new-window default. */
        }
        const id = inventory.some((space) => space.id === wanted) ? wanted! : personal;
        set({ key, personal, inventory, views });
        // Write every migrated home before legacy persistence is suspended.
        for (const [id, view] of Object.entries(views)) save(id, view);
        restore(id, views[id] ?? emptySpaceView());
        if (isGlobal(deps, old)) deps.restore(old);
      },
      select(id) {
        const space = get().inventory.find((space) => space.id === id);
        if (!space) return;
        get().remember();
        departDetachedSpace(get(), id, set, save);
        restore(id, validSpaceView(get().views[id], space));
      },
      remember() {
        const { current, inventory, ownership } = get();
        const space = inventory.find((space) => space.id === current);
        if (!current || !space || restoring) return;
        const captured = deps.capture(ownership);
        // Settings is global and must not replace the organization's destination.
        if (isGlobal(deps, captured)) return;
        const updated = retainUnavailable(inventory, inventory, { ...get().views, [current]: captured }, current);
        if (JSON.stringify(updated) !== JSON.stringify(inventory)) set({ inventory: updated });
        const view = validSpaceView(captured, updated.find((space) => space.id === current) ?? space);
        set({ views: { ...get().views, [current]: view } });
        save(current, view);
      },
      setOwnership(ownership) {
        set({ ownership });
        get().remember();
      },
      observe(spaceId, rows, key) {
        if (get().key !== key) return;
        const inventory = observeSpaceThreads(get().inventory, spaceId, rows);
        if (inventory !== get().inventory) set({ inventory });
      },
      reconcile(inventory) {
        get().remember();
        inventory = retainUnavailable(get().inventory, inventory, get().views, get().current);
        const views = Object.fromEntries(inventory.map((space) => [space.id, validSpaceView(get().views[space.id], space)]));
        const current = inventory.some((space) => space.id === get().current) ? get().current! : get().personal;
        set({ inventory, views });
        if (!current) return;
        const view = views[current] ?? emptySpaceView();
        const captured = deps.capture(get().ownership);
        // Compared regardless of key order: restoring an unchanged view would close the panel.
        if (current !== get().current || (!isGlobal(deps, captured) && sameShape(captured) !== sameShape(view))) restore(current, view);
      },
      end() {
        const view = validSpaceView(localView, localInventory(get().inventory));
        restoring = true;
        deps.restore(view);
        set({ key: null, current: null, personal: null, inventory: [], views: {}, ownership: "everyone", generation: get().generation + 1 });
        restoring = false;
      },
    };
  });
  return store;
}

function departDetachedSpace(state: Navigation, id: string, set: (value: Partial<Navigation>) => void, save: (id: string, view: SpaceView) => void): void {
  const previous = state.inventory.find((space) => space.id === state.current);
  if (id === state.current || !previous?.detached) return;
  const { detached: _detached, ...clean } = previous;
  const view = validSpaceView(state.views[previous.id], clean);
  set({ inventory: state.inventory.map((space) => (space.id === previous.id ? clean : space)), views: { ...state.views, [previous.id]: view } });
  save(previous.id, view);
}

/** A view as JSON with every object's keys in order, so two equal views read the same however each was built. */
const sameShape = (view: SpaceView): string =>
  JSON.stringify(view, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))) : value,
  );

const isGlobal = (deps: Dependencies, view: SpaceView) => ["settings", "onboarding", "orcling"].includes(view.destination.view) || deps.global?.(view.destination) === true;

function saveSpaceView(deps: Dependencies, key: string | null, id: string, view: SpaceView): void {
  if (!key) return;
  const latest = readSpaceRecord(deps.durable, key);
  const { history: _history, future: _future, ...durable } = view;
  try {
    deps.durable.setItem(key, JSON.stringify({ last: id, views: { ...latest.views, [id]: durable } }));
  } catch {
    /* This window still retains its view. */
  }
  try {
    deps.session.setItem(key, id);
  } catch {
    /* Reload uses the durable default. */
  }
}

function capture(ownership: SpaceView["filter"]["ownership"]): SpaceView {
  const route = useRouter.getState();
  const tabs = useThreadTabs.getState();
  const layout = useLayout.getState();
  return {
    destination: route.route,
    panes: route.threadIds,
    ...(route.route.view === "team-chat" && { chatWork: route.chatWork }),
    tabs: tabs.tabs.filter((tab) => !tabs.leaving.includes(tab.id)),
    activeTab: tabs.active,
    history: route.history,
    future: route.future,
    filter: { ownership, pinnedOnly: layout.pinnedOnly, hiddenProjectKeys: layout.hiddenWorkspaces, project: layout.workspace },
  };
}

function restore(view: SpaceView): void {
  navigationScope.active = true;
  navigationScope.restoring = true;
  useUi.setState({ palette: false, importProject: false, importSessions: { open: false }, deleteThreadId: null, moveThreadId: null, removeWorktreeThreadId: null, newFile: null });
  useLayout.setState({
    workspace: view.filter.project,
    pinnedOnly: view.filter.pinnedOnly,
    hiddenWorkspaces: view.filter.hiddenProjectKeys,
    panelThreadId: null,
    selectedFile: null,
    selectedChanges: null,
    panelOpen: false,
  });
  useThreadTabs.setState({ tabs: view.tabs, active: view.activeTab, leaving: [] });
  useRouter.setState({ route: view.destination, threadIds: view.panes, chatWork: view.chatWork ?? null, history: view.history, future: view.future });
  navigationScope.restoring = false;
}

export const spaceNavigation = createSpaceNavigation({ durable: localStorage, session: sessionStorage, capture, restore, global: globalDestination });
spaceNavigation.subscribe((state) => {
  navigationScope.active = state.key !== null;
});
export const useSpaceNavigation = <T>(selector: (state: Navigation) => T): T => useStore(spaceNavigation, selector);
for (const store of [useRouter, useThreadTabs, useLayout])
  store.subscribe(() => {
    if (!navigationScope.restoring) spaceNavigation.getState().remember();
  });

function retainInitialLocal(inventory: SpaceInventory[], personal: string, old: SpaceView): SpaceInventory[] {
  const prior: SpaceInventory = {
    id: personal,
    personal: true,
    projects: inventory.flatMap((space) => space.projects.filter((project) => project.localProjectId)),
    threads: inventory.flatMap((space) => space.threads.filter((thread) => thread.owner?.brain !== "hosted")),
    taskIds: [],
  };
  return retainUnavailable([prior], inventory, { [personal]: old }, personal);
}

function localInventory(inventory: SpaceInventory[]): SpaceInventory {
  return {
    id: "",
    personal: true,
    projects: inventory.flatMap((space) => space.projects.filter((project) => project.localProjectId)),
    threads: inventory.flatMap((space) => space.threads.filter((thread) => thread.owner?.brain !== "hosted")),
    taskIds: [],
  };
}
