import type { OrganizationAccess, SpacesStatus } from "@openorc/protocol";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OrganizationAccessStore } from "./organization-access-store";
import { protectOrganizationContent } from "./organization-frozen-content";
import { createSpaceNavigation } from "./space-navigation";
import { emptySpaceView, type SpaceInventory, type SpaceView } from "./space-view";

const active: OrganizationAccess = { state: "active", reason: null, until: null, message: null };
const grace: OrganizationAccess = { state: "grace", reason: "seat_removed", until: 2000, message: "Your seat was taken back; you have one day to get Pro to keep using organizations." };
const frozen: OrganizationAccess = { state: "frozen", reason: "seat_removed", until: null, message: "Your seat was taken back, and your day of grace has ended." };
type Ready = Extract<SpacesStatus, { state: "ready" }>;
const organization = (id: string, role: "admin" | "member" = "member") => ({ id, kind: "organization" as const, name: id, logo: null, memberId: `${id}-member`, role, memberCount: 2 });
function status(access: OrganizationAccess, spaces: Ready["spaces"] = [{ id: "personal", kind: "personal" }, organization("birch"), organization("cedar", "admin")]): Ready {
  return {
    state: "ready",
    userId: "person",
    apiOrigin: "https://example.com",
    personalSpaceId: "personal",
    spaces,
    create: { allowed: true, reason: null },
    invitations: [],
    reach: "live",
    heardAt: Date.now(),
    error: null,
    organizationAccess: access,
  };
}
const hosted = { brain: "hosted" as const, reach: "live" as const, heardAt: 1 };
const inventory = (): SpaceInventory[] => [
  {
    id: "personal",
    personal: true,
    projects: [{ key: "notes", name: "Notes", repo: null, localProjectId: "notes", hostedProjectId: null, connected: false }],
    threads: [{ id: "note", projectId: "notes", title: "My note" }],
    taskIds: [],
  },
  {
    id: "birch",
    personal: false,
    projects: [
      { key: "canvas", name: "Canvas", repo: "example/canvas", localProjectId: "canvas", hostedProjectId: "hosted-canvas", connected: true },
      { key: "cloud:hosted-atlas", name: "Atlas", repo: "example/atlas", localProjectId: null, hostedProjectId: "hosted-atlas", connected: true },
    ],
    threads: [
      { id: "mine", projectId: "canvas", title: "My local work" },
      { id: "birch-thread", projectId: "canvas", owner: hosted, title: "Quarterly numbers" },
      { id: "birch-other", projectId: "cloud:hosted-atlas", owner: hosted, title: "Hiring plan" },
    ],
    taskIds: ["task"],
  },
  { id: "cedar", personal: false, projects: [], threads: [{ id: "cedar-thread", projectId: "cloud:hosted-fern", owner: hosted, title: "Launch list" }], taskIds: [] },
];
function memory() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), removeItem: (key: string) => void values.delete(key) };
}

const stops: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.useRealTimers();
});

async function fixture(access: OrganizationAccess = active) {
  let answer: SpacesStatus = status(access);
  const gate = new OrganizationAccessStore({ now: Date.now, read: async () => answer });
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let view: SpaceView = emptySpaceView();
  const navigation = createSpaceNavigation({
    durable: memory(),
    session: memory(),
    capture: (ownership) => ({ ...view, filter: { ...view.filter, ownership } }),
    restore: (next) => void (view = next),
  });
  navigation.getState().initialize("key", "personal", inventory());
  const forgotten: string[] = [];
  const overlays = { close: vi.fn() };
  await gate.refresh();
  const drafts = new Map(DRAFTS.map((key) => [key, "{}"]));
  const storage = { keys: () => [...drafts.keys()], removeItem: (key: string) => void drafts.delete(key) };
  stops.push(protectOrganizationContent({ gate, queries, runs: { forget: (ids) => void forgotten.push(...ids) }, navigation, overlays, storage }), () => gate.dispose());
  for (const [method, params] of [
    ["spaces.status", {}],
    ["projects.list", {}],
    ["threads.get", { id: "note" }],
    ["threads.get", { id: "mine" }],
    ["threads.list", { spaceId: "personal", filter: "all" }],
    ["threads.list", { spaceId: "birch", filter: "all" }],
    ["threads.search", { spaceId: "birch", query: "numbers" }],
    ["spaces.projects", { spaceId: "birch" }],
    ["threads.get", { id: "birch-thread" }],
    ["events.page", { runId: "hosted:birch-thread" }],
    ["files.read", { scope: { threadId: "birch-other" }, path: "plan.md" }],
    ["projects.get", { id: "cloud:hosted-atlas" }],
    ["organization.project.access", { spaceId: "birch", projectId: "hosted-canvas" }],
    ["organization.people", { spaceId: "birch", offset: 0, limit: 100 }],
    ["organization.invitations", { spaceId: "birch" }],
    ["threads.get", { id: "cedar-thread" }],
    ["organization.people", { spaceId: "cedar", offset: 0, limit: 100 }],
    ["organization.invitations", { spaceId: "cedar" }],
  ] as const)
    queries.setQueryData([method, params], { cached: method });
  const cached = () =>
    queries
      .getQueryCache()
      .getAll()
      .map((query) => `${String(query.queryKey[0])} ${JSON.stringify(query.queryKey[1])}`);
  return {
    gate,
    queries,
    navigation,
    forgotten,
    drafts: () => [...drafts.keys()],
    overlays,
    cached,
    open: (patch: Partial<SpaceView>, space = "birch") => {
      navigation.getState().select(space);
      view = { ...view, ...patch };
      navigation.getState().remember();
    },
    hear: async (next: SpacesStatus) => {
      answer = next;
      await gate.refresh();
    },
    space: (id: string) => navigation.getState().inventory.find((space) => space.id === id),
  };
}
const DRAFTS = [
  "openorc.draft.conversation.note",
  "openorc.draft.conversation.mine",
  "openorc.draft.conversation.birch-thread",
  "openorc.draft.conversation.birch-thread.attachments",
  "openorc.draft.conversation.cedar-thread",
  "openorc.draft.newthread.cloud:hosted-atlas.execution",
  "openorc.draft.newthread.canvas.execution",
  "openorc.draft.newthread.notes.execution",
];
const LOCAL = ["spaces.status {}", "projects.list {}", 'threads.get {"id":"note"}', 'threads.get {"id":"mine"}', 'threads.list {"spaceId":"personal","filter":"all"}'];

it("removes every cached read of each organization the moment the person is frozen, and keeps Personal and this Mac's threads", async () => {
  const f = await fixture();
  await f.hear(status(frozen));
  expect(f.cached()).toEqual([...LOCAL, 'organization.people {"spaceId":"cedar","offset":0,"limit":100}', 'organization.invitations {"spaceId":"cedar"}']);
  expect(f.forgotten.sort()).toEqual(["hosted:birch-other", "hosted:birch-thread", "hosted:cedar-thread"]);
});

it("cancels a read still on its way, so its answer cannot put the content back", async () => {
  const f = await fixture();
  const late = Promise.withResolvers<unknown>();
  const reading = f.queries.fetchQuery({ queryKey: ["threads.get", { id: "birch-other" }], queryFn: () => late.promise, staleTime: 0 });
  reading.catch(() => {});
  await f.hear(status(frozen));
  late.resolve({ title: "Hiring plan" });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.queries.getQueryData(["threads.get", { id: "birch-other" }])).toBeUndefined();
});

it("closes both organizations at the grace deadline with nothing heard from the server", async () => {
  const f = await fixture(grace);
  expect(f.cached()).toContain('threads.get {"id":"birch-thread"}');
  await f.hear({ state: "loading", error: "OpenOrc Cloud can't be reached." });
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.cached()).toEqual([...LOCAL, 'organization.people {"spaceId":"cedar","offset":0,"limit":100}', 'organization.invitations {"spaceId":"cedar"}']);
  expect(f.space("birch")).toMatchObject({ closed: true, projects: [], threads: [], taskIds: [] });
  expect(f.space("cedar")).toMatchObject({ closed: true, projects: [], threads: [] });
});

it("empties a frozen organization's inventory and keeps an open tab without its title", async () => {
  const f = await fixture();
  f.open({ destination: { view: "thread", threadId: "birch-thread" }, panes: ["birch-thread"], tabs: [{ id: "tab", route: { view: "thread", threadId: "birch-thread" } }], activeTab: "tab" });
  await f.hear(status(frozen));
  expect(f.space("birch")).toMatchObject({ closed: true, projects: [], threads: [], taskIds: [], unavailable: [{ id: "birch-thread", title: "Thread", projectId: "canvas" }] });
  expect(JSON.stringify(f.navigation.getState().inventory)).not.toMatch(/Quarterly numbers|Hiring plan|Launch list|Atlas/);
  expect(f.space("personal")).toEqual(inventory()[0]);
  expect(f.navigation.getState().views["birch"]?.tabs).toEqual([{ id: "tab", route: { view: "thread", threadId: "birch-thread" } }]);
});

it("does not bring a title back when the frozen organizations are reconciled again", async () => {
  const f = await fixture();
  f.open({ destination: { view: "thread", threadId: "birch-thread" }, panes: ["birch-thread"] });
  await f.hear(status(frozen));
  f.navigation
    .getState()
    .reconcile([
      inventory()[0]!,
      { id: "birch", personal: false, projects: [], threads: [], taskIds: [], closed: true },
      { id: "cedar", personal: false, projects: [], threads: [], taskIds: [], closed: true },
    ]);
  expect(JSON.stringify(f.navigation.getState().inventory)).not.toMatch(/Quarterly numbers|Hiring plan|Launch list/);
  expect(f.space("birch")?.unavailable).toEqual([{ id: "birch-thread", title: "Thread", projectId: "canvas" }]);
});

it("keeps a frozen member's threads out of a list answer that arrives late", async () => {
  const f = await fixture();
  await f.hear(status(frozen));
  f.navigation.getState().observe("birch", [{ id: "birch-thread", projectId: "canvas", owner: hosted, title: "Quarterly numbers" }], "key");
  expect(f.space("birch")?.threads).toEqual([]);
});

it("closes only the organization a person was removed from", async () => {
  const f = await fixture();
  await f.hear(status(active, [{ id: "personal", kind: "personal" }, organization("cedar", "admin")]));
  expect(f.cached()).toEqual([...LOCAL, 'threads.get {"id":"cedar-thread"}', 'organization.people {"spaceId":"cedar","offset":0,"limit":100}', 'organization.invitations {"spaceId":"cedar"}']);
  expect(f.forgotten.sort()).toEqual(["hosted:birch-other", "hosted:birch-thread"]);
  expect(f.space("cedar")?.threads).toHaveLength(1);
});

it("removes nothing when only a role changes while access is open", async () => {
  const f = await fixture();
  const before = f.cached();
  await f.hear(status(active, [{ id: "personal", kind: "personal" }, organization("birch", "admin"), organization("cedar", "admin")]));
  expect(f.cached()).toEqual(before);
  expect(f.forgotten).toEqual([]);
  expect(f.space("birch")?.threads).toHaveLength(3);
});

it("takes a demoted admin's people and invitations too while frozen", async () => {
  const f = await fixture(frozen);
  f.queries.setQueryData(["organization.people", { spaceId: "cedar", offset: 0, limit: 100 }], { cached: true });
  await f.hear(status(frozen, [{ id: "personal", kind: "personal" }, organization("birch"), organization("cedar")]));
  expect(f.cached().filter((key) => key.startsWith("organization."))).toEqual([]);
});

it("drops what was cached while frozen when access returns, so the organization is read fresh", async () => {
  const f = await fixture();
  await f.hear(status(frozen));
  f.queries.setQueryData(["threads.list", { spaceId: "birch", filter: "all" }], [{ id: "birch-thread", title: "Quarterly numbers" }]);
  f.queries.setQueryData(["threads.get", { id: "note" }], { cached: true });
  await f.hear(status(active));
  expect(f.queries.getQueryData(["threads.list", { spaceId: "birch", filter: "all" }])).toBeUndefined();
  expect(f.queries.getQueryData(["threads.get", { id: "note" }])).toEqual({ cached: true });
  expect(f.space("birch")).toMatchObject({ closed: true, threads: [] });
});

it("reads an organization fresh when a person frozen since this window opened gets access", async () => {
  const f = await fixture(frozen);
  f.navigation
    .getState()
    .reconcile([
      inventory()[0]!,
      { id: "birch", personal: false, projects: [], threads: [], taskIds: [], closed: true },
      { id: "cedar", personal: false, projects: [], threads: [], taskIds: [], closed: true },
    ]);
  f.queries.setQueryData(["spaces.projects", { spaceId: "birch" }], [{ key: "cloud:hosted-atlas", name: "Atlas" }]);
  await f.hear(status(active));
  expect(f.queries.getQueryData(["spaces.projects", { spaceId: "birch" }])).toBeUndefined();
});

it("closes the palette and the thread dialogs only for a window standing in a closed organization", async () => {
  const personal = await fixture();
  await personal.hear(status(frozen));
  expect(personal.overlays.close).not.toHaveBeenCalled();
  const inside = await fixture();
  inside.open({});
  await inside.hear(status(frozen));
  expect(inside.overlays.close).toHaveBeenCalledTimes(1);
});

it("keeps every unsent draft through a freeze", async () => {
  const f = await fixture();
  await f.hear(status(frozen));
  expect(f.drafts()).toEqual(DRAFTS);
});

it("drops the drafts of an organization the person no longer belongs to, and no other", async () => {
  const f = await fixture();
  await f.hear(status(active, [{ id: "personal", kind: "personal" }, organization("cedar", "admin")]));
  expect(f.drafts()).toEqual([
    "openorc.draft.conversation.note",
    "openorc.draft.conversation.mine",
    "openorc.draft.conversation.cedar-thread",
    "openorc.draft.newthread.canvas.execution",
    "openorc.draft.newthread.notes.execution",
  ]);
});

it("drops every organization's drafts when another account signs in", async () => {
  const f = await fixture();
  await f.hear({ ...status(active, [{ id: "other-personal", kind: "personal" }]), userId: "someone-else", personalSpaceId: "other-personal" });
  expect(f.drafts()).toEqual(["openorc.draft.conversation.note", "openorc.draft.conversation.mine", "openorc.draft.newthread.canvas.execution", "openorc.draft.newthread.notes.execution"]);
});

it("removes a list that names no space but holds a closed organization's thread, and keeps one that holds only this Mac's", async () => {
  const f = await fixture();
  const unscoped = ["threads.list", { projectIds: ["canvas"], filter: "active" }];
  const local = ["threads.list", { projectIds: ["notes"], filter: "active" }];
  f.queries.setQueryData(unscoped, [
    { id: "mine", title: "My local work" },
    { id: "birch-thread", title: "Quarterly numbers" },
  ]);
  f.queries.setQueryData(local, [{ id: "note", title: "My note" }]);
  await f.hear(status(frozen));
  expect(f.queries.getQueryData(unscoped)).toBeUndefined();
  expect(f.queries.getQueryData(local)).toEqual([{ id: "note", title: "My note" }]);
});

it("keeps the reads that only name an organization, the person's spaces and account among them", async () => {
  const f = await fixture();
  f.queries.setQueryData(["spaces.status", {}], status(active));
  f.queries.setQueryData(["account.status", {}], { state: "signed-in", allowanceSource: { kind: "organization", organizationId: "birch", organizationName: "birch" } });
  await f.hear(status(frozen));
  expect(f.queries.getQueryData(["spaces.status", {}])).toBeDefined();
  expect(f.queries.getQueryData(["account.status", {}])).toBeDefined();
});
