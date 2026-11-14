import { afterEach, expect, it } from "vitest";
import { createSpaceNavigation, spaceNavigation } from "./space-navigation";
import { emptySpaceView, type SpaceInventory, type SpaceView } from "./space-view";
import { navigationScope } from "./navigation-scope";
import { useRouter } from "./router";
import { useThreadTabs } from "./thread-tabs";
import { queryClient } from "./client";

const spaces: SpaceInventory[] = [
  {
    id: "personal",
    personal: true,
    projects: [{ key: "notes", name: "Notes", repo: null, localProjectId: "notes", hostedProjectId: null, connected: false }],
    threads: [{ id: "note", projectId: "notes" }],
    taskIds: [],
  },
  {
    id: "birch",
    personal: false,
    projects: [{ key: "canvas", name: "Canvas", repo: "example/canvas", localProjectId: "canvas", hostedProjectId: "hosted-canvas", connected: true }],
    threads: [
      { id: "a", projectId: "canvas" },
      { id: "b", projectId: "canvas" },
      { id: "cloud", projectId: "canvas", owner: { brain: "hosted", reach: "live", heardAt: 1 } },
    ],
    taskIds: [],
  },
];
function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
function windowOf(durable = memory(), session = memory()) {
  let view: SpaceView = emptySpaceView();
  const store = createSpaceNavigation({
    durable,
    session,
    capture: (ownership) => ({ ...view, filter: { ...view.filter, ownership } }),
    restore: (next) => {
      view = next;
    },
  });
  return {
    store,
    durable,
    session,
    get: () => view,
    edit: (patch: Partial<SpaceView>) => {
      view = { ...view, ...patch };
      store.getState().remember();
    },
  };
}
afterEach(() => {
  if (spaceNavigation.getState().key) spaceNavigation.getState().end();
  navigationScope.active = false;
  localStorage.clear();
  sessionStorage.clear();
  queryClient.clear();
});

it("restores each space's split, tabs, destination, history and filter with no cross-space back step", () => {
  const w = windowOf();
  w.store.getState().initialize("key", "personal", spaces);
  w.edit({ destination: { view: "thread", threadId: "note" }, tabs: [{ id: "note-tab", route: { view: "thread", threadId: "note" } }], activeTab: "note-tab", panes: ["note"] });
  w.store.getState().select("birch");
  w.edit({
    destination: { view: "thread", threadId: "b" },
    panes: ["a", "b"],
    tabs: [{ id: "tab", route: { view: "thread", threadId: "a" } }],
    activeTab: "tab",
    history: [{ view: "people", spaceId: "birch" }],
  });
  w.store.getState().setOwnership("mine");
  w.store.getState().select("personal");
  expect(w.get()).toMatchObject({ destination: { threadId: "note" }, panes: ["note"], history: [] });
  w.store.getState().select("birch");
  expect(w.get()).toMatchObject({ destination: { threadId: "b" }, panes: ["a", "b"], activeTab: "tab", filter: { ownership: "mine" }, history: [{ view: "people", spaceId: "birch" }] });
});

it("keeps two windows independent and merges each space snapshot instead of erasing another window's work", () => {
  const shared = memory();
  const a = windowOf(shared);
  a.store.getState().initialize("key", "personal", spaces);
  const b = windowOf(shared);
  b.store.getState().initialize("key", "personal", spaces);
  a.store.getState().select("birch");
  a.edit({ destination: { view: "people", spaceId: "birch" } });
  b.edit({ destination: { view: "tasks" } });
  expect(b.store.getState().current).toBe("personal");
  expect(a.store.getState().current).toBe("birch");
  const reopened = windowOf(shared, a.session);
  reopened.store.getState().initialize("key", "personal", spaces);
  expect(reopened.store.getState().current).toBe("birch");
  expect(reopened.get().destination).toEqual({ view: "people", spaceId: "birch" });
  reopened.store.getState().select("personal");
  expect(reopened.get().destination).toEqual({ view: "tasks" });
});

it("migrates local tabs into all valid homes and does not save Settings as an organization's home", () => {
  const w = windowOf();
  w.edit({
    destination: { view: "thread", threadId: "a" },
    tabs: [
      { id: "a", route: { view: "thread", threadId: "a" } },
      { id: "note", route: { view: "thread", threadId: "note" } },
    ],
  });
  w.store.getState().initialize("key", "personal", [...spaces, { ...spaces[1]!, id: "cedar" }]);
  expect(w.get().tabs.map((tab) => tab.id)).toEqual(["note"]);
  w.store.getState().select("birch");
  expect(w.get().tabs.map((tab) => tab.id)).toEqual(["a"]);
  w.edit({ destination: { view: "people", spaceId: "birch" } });
  w.edit({ destination: { view: "settings", section: "account" } });
  w.store.getState().select("cedar");
  expect(w.get().tabs.map((tab) => tab.id)).toEqual(["a"]);
  w.store.getState().select("birch");
  expect(w.get().destination).toEqual({ view: "people", spaceId: "birch" });
});

it("drops revoked cloud tabs before restoring and returns to Personal when membership disappears", () => {
  const w = windowOf();
  w.store.getState().initialize("key", "personal", spaces);
  w.store.getState().select("birch");
  w.edit({ destination: { view: "thread", threadId: "cloud" }, tabs: [{ id: "cloud", route: { view: "thread", threadId: "cloud" } }], panes: ["cloud"] });
  w.store.getState().reconcile([spaces[0]!, { ...spaces[1]!, threads: spaces[1]!.threads.filter((row) => row.id !== "cloud") }]);
  expect(w.get()).toMatchObject({ destination: { view: "newthread" }, tabs: [], panes: [] });
  w.store.getState().reconcile([spaces[0]!]);
  expect(w.store.getState().current).toBe("personal");
});

it("keeps newly started work across switches while rejecting an old account's late result", () => {
  const w = windowOf();
  w.store.getState().initialize("key", "personal", spaces);
  w.store.getState().select("birch");
  w.store.getState().observe("birch", [{ id: "new", projectId: "canvas" }], "key");
  w.edit({ destination: { view: "thread", threadId: "new" }, panes: ["new"], tabs: [{ id: "new", route: { view: "thread", threadId: "new" } }] });
  w.store.getState().select("personal");
  w.store.getState().select("birch");
  expect(w.get().destination).toEqual({ view: "thread", threadId: "new" });
  w.store.getState().initialize("other", "personal", spaces);
  w.store.getState().observe("birch", [{ id: "late", projectId: "canvas" }], "key");
  expect(
    w.store
      .getState()
      .inventory.flatMap((space) => space.threads)
      .some((thread) => thread.id === "late"),
  ).toBe(false);
});

it("leaves a global Orcling or group chat for the space's previous project-work destination", () => {
  queryClient.setQueryData(["orclings.list", {}], [{ threadId: "orcling-home" }]);
  queryClient.setQueryData(["orclings.groups.list", {}], [{ threadId: "group-home" }]);
  spaceNavigation.getState().initialize("global-chat", "personal", spaces);
  spaceNavigation.getState().select("birch");
  useRouter.getState().navigate({ view: "people", spaceId: "birch" });
  for (const threadId of ["orcling-home", "group-home"]) {
    useRouter.getState().navigate({ view: "thread", threadId });
    spaceNavigation.getState().reconcile(spaces);
    expect(useRouter.getState().route).toEqual({ view: "thread", threadId });
    spaceNavigation.getState().select("personal");
    spaceNavigation.getState().select("birch");
    expect(useRouter.getState().route).toEqual({ view: "people", spaceId: "birch" });
  }
});

it("does not restore another account or a malformed cache and leaves old local tab storage intact", () => {
  const w = windowOf();
  w.durable.setItem("key", JSON.stringify({ last: "birch", views: { birch: { destination: { view: "thread", threadId: {} }, tabs: [null, { id: "bad", route: {} }] } } }));
  w.store.getState().initialize("key", "personal", spaces);
  expect(w.get().destination).toEqual({ view: "newthread" });
  w.edit({ destination: { view: "people", spaceId: "birch" } });
  w.store.getState().initialize("other-account", "personal", spaces);
  expect(w.store.getState().current).toBe("personal");
  expect(w.get().destination).toEqual({ view: "newthread" });
  localStorage.setItem("openorc.threadTabs", "legacy");
  spaceNavigation.getState().initialize("integration", "personal", spaces);
  spaceNavigation.getState().select("birch");
  useRouter.getState().navigate({ view: "thread", threadId: "a" });
  useRouter.getState().addThreadPane("b");
  useRouter.getState().focusThreadPane("b");
  spaceNavigation.getState().select("personal");
  spaceNavigation.getState().select("birch");
  expect(useRouter.getState().threadIds).toEqual(["a", "b"]);
  expect(useThreadTabs.getState().tabs).toMatchObject([{ route: { view: "thread", threadId: "a" } }]);
  expect(localStorage.getItem("openorc.threadTabs")).toBe("legacy");
  spaceNavigation.getState().end();
  expect(spaceNavigation.getState().current).toBeNull();
});

it("holds an open revoked project tab in place and restores it on regrant while local work returns to Personal", () => {
  const w = windowOf();
  const before = structuredClone(spaces);
  before[1]!.threads.find((row) => row.id === "cloud")!.title = "Retained title";
  w.store.getState().initialize("key", "personal", before);
  w.store.getState().select("birch");
  w.edit({
    destination: { view: "thread", threadId: "cloud" },
    tabs: [{ id: "cloud-tab", route: { view: "thread", threadId: "cloud" } }],
    activeTab: "cloud-tab",
    panes: ["cloud"],
    filter: { ...w.get().filter, project: "canvas" },
  });
  const personal = {
    ...before[0]!,
    projects: [...before[0]!.projects, before[1]!.projects[0]!],
    threads: [...before[0]!.threads, ...before[1]!.threads.filter((row) => row.owner?.brain !== "hosted")],
  };
  const revoked = [personal, { ...before[1]!, projects: [], threads: [] }];
  w.store.getState().reconcile(revoked);
  expect(w.get()).toMatchObject({ destination: { view: "thread", threadId: "cloud" }, activeTab: "cloud-tab", panes: ["cloud"], filter: { project: "all" } });
  expect(w.store.getState().inventory[1]!.unavailable).toEqual([{ id: "cloud", title: "Retained title", projectId: "canvas" }]);
  const restarted = windowOf(w.durable, w.session);
  restarted.store.getState().initialize("key", "personal", revoked);
  expect(restarted.get()).toMatchObject({ destination: { view: "newthread" }, tabs: [] });
  w.store.getState().reconcile(before);
  expect(w.get().destination).toEqual({ view: "thread", threadId: "cloud" });
  expect(w.store.getState().inventory[1]!.unavailable).toEqual([]);
});

it("quietly removes a lost project filter from Tasks and Pull requests", () => {
  for (const view of ["tasks", "pulls"] as const) {
    const w = windowOf();
    w.store.getState().initialize("key", "personal", spaces);
    w.store.getState().select("birch");
    w.edit({ destination: { view }, filter: { ...w.get().filter, project: "canvas" } });
    w.store.getState().reconcile([spaces[0]!, { ...spaces[1]!, projects: [], threads: [] }]);
    expect(w.get().destination).toEqual({ view });
    expect(w.get().filter.project).toBe("all");
  }
});

it("keeps an already open local conversation usable until space switch after its paired project is lost", () => {
  const w = windowOf();
  w.store.getState().initialize("key", "personal", spaces);
  w.store.getState().select("birch");
  w.edit({ destination: { view: "thread", threadId: "a" }, tabs: [{ id: "a-tab", route: { view: "thread", threadId: "a" } }], panes: ["a"] });
  const personal = {
    ...spaces[0]!,
    projects: [...spaces[0]!.projects, ...spaces[1]!.projects],
    threads: [...spaces[0]!.threads, ...spaces[1]!.threads.filter((row) => row.owner?.brain !== "hosted")],
  };
  const lost = [personal, { ...spaces[1]!, projects: [], threads: [] }];
  w.store.getState().reconcile(lost);
  expect(w.get().destination).toEqual({ view: "thread", threadId: "a" });
  expect(w.store.getState().inventory[1]!.detached?.threads.map((row) => row.id)).toEqual(["a"]);
  expect(w.store.getState().inventory[1]!.projects).toEqual([]);
  w.store.getState().reconcile(lost);
  expect(w.get().destination).toEqual({ view: "thread", threadId: "a" });
  w.store.getState().observe("birch", [{ id: "new-local", projectId: "canvas" }], "key");
  w.edit({ destination: { view: "thread", threadId: "new-local" }, panes: ["new-local"], tabs: [...w.get().tabs, { id: "new-tab", route: { view: "thread", threadId: "new-local" } }] });
  expect(w.store.getState().inventory[0]!.threads.some((row) => row.id === "new-local")).toBe(true);
  expect(w.store.getState().inventory[1]!.threads).toEqual([]);
  w.store.getState().select("personal");
  w.store.getState().select("birch");
  expect(w.get()).toMatchObject({ destination: { view: "newthread" }, tabs: [] });
});
