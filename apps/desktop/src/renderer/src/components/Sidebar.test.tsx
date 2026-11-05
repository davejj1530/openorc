import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { defaultOrclingLook, WORKSPACE_ID, type RpcParams, type ThreadSummary } from "@openorc/protocol";

vi.hoisted(() => Object.assign(window, { openorc: { platform: "darwin" } }));

const fixture: {
  projects: { id: string; name: string; rootPath: string }[];
  threads: (Pick<ThreadSummary, "id" | "title" | "projectId" | "agent" | "activity" | "unread" | "session" | "pinnedAt" | "snoozedUntil" | "lastActivityAt"> &
    Partial<Pick<ThreadSummary, "createdAt" | "archivedAt" | "parentThreadId" | "parentRelation" | "subagent" | "prUrl" | "prState">>)[];
} = vi.hoisted(() => ({ projects: [], threads: [] }));

/** The core's answer to a thread list, as the fixture's threads read. */
const listThreads = vi.hoisted(() => (params: RpcParams<"threads.list">) => {
  const rows = fixture.threads.filter(
    (thread) =>
      (!params.projectId || thread.projectId === params.projectId) &&
      (!params.projectIds || params.projectIds.includes(thread.projectId)) &&
      (!params.pinnedOnly || thread.pinnedAt) &&
      (!params.needsYou || thread.unread || thread.activity !== "idle") &&
      (params.filter === "archived") === Boolean(thread.archivedAt),
  );
  if (params.orderBy === "activity") rows.sort((a, b) => b.lastActivityAt - a.lastActivityAt || b.id.localeCompare(a.id));
  return rows.slice(0, params.limit);
});

vi.mock("../lib/client", async (original) => {
  const rpcData = (method: string, params: { id?: string }) => {
    if (method === "threads.get" && !params.id) return null;
    if (method === "projects.list") return fixture.projects;
    if (method === "orclings.list") return [{ id: "rini", name: "Rini", threadId: "rini-home", look: defaultOrclingLook }];
    if (method === "threads.get")
      return (
        fixture.threads.find((thread) => thread.id === params.id) ?? {
          id: params.id,
          title: "Notes",
          projectId: WORKSPACE_ID,
          agent: "codex",
          activity: "idle",
          unread: false,
          session: { status: "idle", message: null },
        }
      );
    if (method === "threads.list") return listThreads(params as RpcParams<"threads.list">);
    return undefined;
  };
  return {
    ...(await original<object>()),
    useRpc: (method: string, params: { id?: string }, options?: { enabled?: boolean }) => ({ data: options?.enabled === false ? undefined : rpcData(method, params) }),
    usePendingApprovals: () => 0,
    useRun: () => undefined,
  };
});
vi.mock("../lib/rpc", () => ({
  core: {
    call: vi.fn(async (method: string, params: RpcParams<"threads.list">) => {
      if (method === "threads.get") return fixture.threads.find((thread) => thread.id === (params as { id?: string }).id) ?? null;
      if (method !== "threads.list") return [];
      return listThreads(params);
    }),
    onPush: () => () => {},
  },
}));
vi.mock("../lib/browser-preview", () => ({ CoversPreview: () => null }));
vi.mock("./ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ui")>()),
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));

import { useLayout } from "../lib/layout";
import { useRouter } from "../lib/router";
import { useUi } from "../lib/ui";
import { useWindow } from "../lib/window";
import { Sidebar } from "./Sidebar";
import { core } from "../lib/rpc";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  fixture.projects = [];
  fixture.threads = [];
  localStorage.clear();
  useWindow.setState({ fullscreen: false });
  useLayout.setState({ collapsed: [], projectId: null, sidebarOpen: true, sidebarFilter: "active", pinnedOnly: false, hiddenProjects: [] });
  useRouter.setState({ route: { view: "newthread" }, history: [], future: [], threadIds: [] });
});

const mountSidebar = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Sidebar />
    </QueryClientProvider>,
  );

const ago = (days: number) => Date.now() - days * 86_400_000;
it("marks missing subagent updates with a neutral dashed circle", async () => {
  fixture.threads = [
    {
      id: "legacy-child",
      title: "Legacy child",
      projectId: WORKSPACE_ID,
      agent: "opencode",
      activity: "idle",
      unread: false,
      session: { status: "idle", message: null },
      pinnedAt: null,
      snoozedUntil: null,
      lastActivityAt: 1,
      parentThreadId: "parent",
      parentRelation: "subagent",
      subagent: { status: "no_updates", agentType: null, toolCallId: null, startedAt: 1, endedAt: 2, stoppable: false },
    },
  ];
  fixture.threads.unshift({ ...fixture.threads[0]!, id: "parent", title: "Parent", parentThreadId: null, parentRelation: null, subagent: undefined });
  useRouter.setState({ route: { view: "thread", threadId: "legacy-child" } });
  mountSidebar();
  const mark = await screen.findByRole("img", { name: "No updates" });
  expect(mark.querySelector("circle[stroke-dasharray]")).not.toBeNull();
  expect(mark.className).not.toContain("text-bad");
});

const open = (threadId: string) => {
  useLayout.setState({ sidebarOpen: true });
  useRouter.setState({ route: { view: "thread", threadId } });
  mountSidebar();
};

it("keeps the sidebar and keyboard order visible during a thread switch", async () => {
  fixture.threads = [
    {
      id: "one",
      title: "First",
      projectId: WORKSPACE_ID,
      agent: "codex",
      activity: "idle",
      unread: false,
      session: { status: "idle", message: null },
      pinnedAt: null,
      snoozedUntil: null,
      lastActivityAt: Date.now() - 1000,
    },
    {
      id: "two",
      title: "Second",
      projectId: WORKSPACE_ID,
      agent: "codex",
      activity: "idle",
      unread: false,
      session: { status: "idle", message: null },
      pinnedAt: null,
      snoozedUntil: null,
      lastActivityAt: Date.now() - 2000,
    },
  ];
  mountSidebar();
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(["one", "two"]));
  const implementation = vi.mocked(core.call).getMockImplementation()!;
  vi.mocked(core.call).mockImplementation(() => new Promise(() => {}));
  try {
    act(() => useRouter.setState({ route: { view: "thread", threadId: "two" } }));
    expect(screen.queryByText("Loading threads…")).toBeNull();
    expect(useUi.getState().threadOrder).toEqual(["one", "two"]);
    expect(screen.getByText("First")).toBeTruthy();
  } finally {
    vi.mocked(core.call).mockImplementation(implementation);
  }
});

it("fetches another child page and keeps rows while loading", async () => {
  const parent = {
    id: "parent",
    title: "Parent",
    projectId: WORKSPACE_ID,
    agent: "claude",
    activity: "idle",
    unread: false,
    session: { status: "idle", message: null },
    pinnedAt: null,
    snoozedUntil: null,
    lastActivityAt: Date.now() - 1000,
    createdAt: 0,
  } as const;
  const children = Array.from({ length: 20 }, (_, i) => ({
    ...parent,
    id: `child-${i}`,
    title: `Child ${i}`,
    parentThreadId: parent.id,
    parentRelation: "subagent" as const,
    createdAt: i,
    activity: i === 0 ? ("running" as const) : ("idle" as const),
  }));
  fixture.threads = [parent, ...children];
  const implementation = vi.mocked(core.call).getMockImplementation()!;
  let release: (() => void) | undefined;
  vi.mocked(core.call).mockImplementation(async (method, params) => {
    if (method !== "threads.list") return implementation(method, params);
    const list = params as RpcParams<"threads.list">;
    if (list.childLimits?.[parent.id] === 17)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    const shown = [...children].reverse().filter((child, index) => index < (list.childLimits?.[parent.id] ?? 5) || child.activity === "running");
    return [{ ...parent, hiddenChildren: children.length - shown.length }, ...shown] as never;
  });
  try {
    mountSidebar();
    await screen.findByRole("button", { name: "Show 14 more in Parent" });
    expect(useUi.getState().threadOrder).toEqual(["parent", "child-19", "child-18", "child-17", "child-16", "child-15", "child-0"]);
    fireEvent.click(screen.getByRole("button", { name: "Show 14 more in Parent" }));
    expect(screen.getByText("Child 19")).toBeTruthy();
    await waitFor(() => expect(release).toBeTypeOf("function"));
    await act(async () => release!());
    await screen.findByRole("button", { name: "Show 2 more in Parent" });
    expect(useUi.getState().threadOrder).toHaveLength(19);
  } finally {
    vi.mocked(core.call).mockImplementation(implementation);
  }
});

it("leads the window corner with the OpenOrc wordmark, in and out of fullscreen, and heads the list with the app's one search", () => {
  mountSidebar();
  const corner = () => screen.getByRole("group", { name: "Window" }).closest("header");
  expect(screen.getByRole("img", { name: "OpenOrc" }).textContent).toBe("OpenOrc");
  expect(screen.getByRole("img", { name: "OpenOrc" }).closest("header")).toBe(corner());
  expect(
    within(screen.getByRole("group", { name: "Window" }))
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label")),
  ).toEqual(["Inbox", "Toggle sidebar"]);
  act(() => useWindow.setState({ fullscreen: true }));
  expect(screen.getAllByRole("img", { name: "OpenOrc" })).toHaveLength(1);
  expect(screen.getByRole("img", { name: "OpenOrc" }).closest("header")).toBe(corner());
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(useUi.getState()).toMatchObject({ palette: true, paletteMode: "all" });
});

it("switches between project threads and Orclings with the footer's Orclings button, remembering the project thread", () => {
  open("notes");
  expect(screen.getByRole("region", { name: "Thread browser" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Orclings" })).toBeNull();
  const orclings = () => within(screen.getByRole("navigation", { name: "Screens" })).getByRole("button", { name: "Orclings" });
  expect(orclings().getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(orclings());
  expect(useRouter.getState().route).toEqual({ view: "thread", threadId: "rini-home" });
  expect(screen.queryByRole("region", { name: "Thread browser" })).toBeNull();
  expect(screen.getByRole("region", { name: "Orclings" })).toBeTruthy();
  expect(orclings().getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(orclings());
  expect(useRouter.getState().route).toEqual({ view: "thread", threadId: "notes" });
  expect(screen.getByRole("region", { name: "Thread browser" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Orclings" })).toBeNull();
});

it("opens project conversations when Orclings is turned off from an initial Orcling chat", () => {
  open("rini-home");
  fireEvent.click(within(screen.getByRole("navigation", { name: "Screens" })).getByRole("button", { name: "Orclings" }));
  expect(useRouter.getState().route).toMatchObject({ view: "newthread" });
  expect(screen.queryByRole("region", { name: "Orclings" })).toBeNull();
});

it("reaches the app's screens from the footer, marking the open one as current", () => {
  open("notes");
  const dock = screen.getByRole("navigation", { name: "Screens" });
  expect(
    within(dock)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label")),
  ).toEqual(["Tasks", "Pull requests", "Schedules", "Orclings", "Settings"]);
  fireEvent.click(within(dock).getByRole("button", { name: "Schedules" }));
  expect(useRouter.getState().route).toEqual({ view: "scheduled" });
  expect(within(dock).getByRole("button", { name: "Schedules" }).getAttribute("aria-current")).toBe("page");
  expect(within(dock).getByRole("button", { name: "Tasks" }).getAttribute("aria-current")).toBeNull();
  expect(screen.queryByRole("button", { name: "More" })).toBeNull();
});

it("starts a new thread from the list head, leaving Add project to the new thread's question", () => {
  open("notes");
  fireEvent.click(screen.getByRole("button", { name: "New thread" }));
  expect(useRouter.getState().route).toMatchObject({ view: "newthread" });
  expect(screen.queryByRole("button", { name: "Add project" })).toBeNull();
});

it("lists Settings' sections in place of the app's navigation, then goes back to the screen Settings was opened from", () => {
  useRouter.setState({ route: { view: "settings", section: "slack" }, history: [{ view: "tasks" }, { view: "settings" }] });
  mountSidebar();
  const sections = screen.getByRole("navigation", { name: "Settings" });
  expect(
    within(sections)
      .getAllByRole("button")
      .map((row) => row.textContent),
  ).toEqual(["Usage", "Connections", "Cloud", "Slack", "Phone", "Skills", "Devices", "Appearance", "General", "Memory & models", "Data"]);
  expect(within(sections).getByRole("button", { name: "Slack" }).getAttribute("aria-current")).toBe("page");
  expect(screen.queryByRole("button", { name: "New thread" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Add project" })).toBeNull();
  // The thread list waits underneath, so its loaded pages and scroll survive the visit.
  expect(screen.getByRole("region", { name: "Thread browser", hidden: true })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Thread browser" })).toBeNull();

  fireEvent.click(within(sections).getByRole("button", { name: "Appearance" }));
  expect(useRouter.getState().route).toEqual({ view: "settings", section: "appearance" });
  expect(within(sections).getByRole("button", { name: "Appearance" }).getAttribute("aria-current")).toBe("page");

  fireEvent.click(screen.getByRole("button", { name: "Back to app" }));
  expect(useRouter.getState().route).toEqual({ view: "tasks" });
  expect(screen.queryByRole("navigation", { name: "Settings" })).toBeNull();
  expect(screen.getByRole("button", { name: "New thread" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
});

it("goes back to a new thread when Settings was opened first", () => {
  useRouter.setState({ route: { view: "settings" } });
  mountSidebar();
  expect(
    within(screen.getByRole("navigation", { name: "Settings" }))
      .getByRole("button", { name: "Usage" })
      .getAttribute("aria-current"),
  ).toBe("page");
  fireEvent.click(screen.getByRole("button", { name: "Back to app" }));
  expect(useRouter.getState().route).toEqual({ view: "newthread" });
});

it.each([
  ["Inbox", "inbox"],
  ["Settings", "settings"],
])("dismisses compact navigation after choosing %s", (label, destination) => {
  const matchMedia = window.matchMedia;
  window.matchMedia = (query) => ({ ...matchMedia(query), matches: query === "(max-width: 900px)" });
  try {
    useRouter.setState({ history: [{ view: "tasks" }], future: [{ view: "settings" }] });
    mountSidebar();
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(useRouter.getState().route.view).toBe(destination);
    expect(useLayout.getState().sidebarOpen).toBe(false);
  } finally {
    window.matchMedia = matchMedia;
  }
});

function projectThreads() {
  fixture.projects = [
    { id: "one", name: "First project", rootPath: "/projects/one" },
    { id: "two", name: "Second project", rootPath: "/projects/two" },
  ];
  fixture.threads = [
    { id: "pinned", title: "Pinned notes", projectId: "one", pinnedAt: 1, snoozedUntil: null },
    { id: "regular", title: "Regular notes", projectId: "one", pinnedAt: null, snoozedUntil: null },
    { id: "snoozed", title: "Snoozed notes", projectId: "one", pinnedAt: null, snoozedUntil: Date.now() + 60_000 },
    { id: "other", title: "Other notes", projectId: "two", pinnedAt: null, snoozedUntil: null },
  ].map((thread) => ({ ...thread, agent: "codex", activity: "idle", unread: false, session: { status: "idle", message: null }, lastActivityAt: Date.now() }));
}

function dayThreads() {
  fixture.projects = [{ id: "one", name: "First project", rootPath: "/projects/one" }];
  fixture.threads = [
    { id: "today", title: "Today's notes", lastActivityAt: Date.now() - 1000 },
    { id: "yesterday", title: "Yesterday's notes", lastActivityAt: ago(1) },
    { id: "week", title: "This week's notes", lastActivityAt: ago(3) },
    { id: "older", title: "Old notes", lastActivityAt: ago(30) },
  ].map((thread) => ({ ...thread, projectId: "one", agent: "codex", activity: "idle", unread: false, session: { status: "idle", message: null }, pinnedAt: null, snoozedUntil: null }));
}

const section = (name: string) => screen.getByRole("button", { name }).getAttribute("aria-expanded");

it("keeps what needs you in a folded day, even past the loaded pages, and nothing else of it", async () => {
  fixture.projects = [
    { id: "one", name: "First project", rootPath: "/projects/one" },
    { id: "two", name: "Second project", rootPath: "/projects/two" },
  ];
  const base = { agent: "codex", activity: "idle", unread: false, session: { status: "idle", message: null }, pinnedAt: null, snoozedUntil: null } as const;
  fixture.threads = [
    ...Array.from({ length: 14 }, (_, index) => ({ ...base, id: `week-${index}`, title: `Week notes ${index}`, projectId: "one", lastActivityAt: ago(3) - index })),
    { ...base, id: "waiting", title: "Waiting on you", projectId: "one", lastActivityAt: ago(3) - 100, activity: "waiting" as const },
    { ...base, id: "unread", title: "Old unread result", projectId: "two", lastActivityAt: ago(30), unread: true },
    { ...base, id: "quiet", title: "Old quiet notes", projectId: "two", lastActivityAt: ago(30) },
  ];
  mountSidebar();
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(["waiting", "unread"]));
  expect(screen.queryByRole("button", { name: /Old quiet notes|Week notes 0/ })).toBeNull();
  expect(["Last 7 days", "Older"].map(section)).toEqual(["false", "false"]);
});

it("lists threads by day, today and yesterday open, the last week and older folded, and keeps the reader's folds", async () => {
  dayThreads();
  const view = mountSidebar();
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(["today", "yesterday"]));
  expect(["Today", "Yesterday", "Last 7 days", "Older"].map(section)).toEqual(["true", "true", "false", "false"]);
  expect(screen.queryByRole("button", { name: /This week's notes|Old notes/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Last 7 days" }));
  expect(useUi.getState().threadOrder).toEqual(["today", "yesterday", "week"]);
  fireEvent.click(screen.getByRole("button", { name: "Today" }));
  expect(useUi.getState().threadOrder).toEqual(["yesterday", "week"]);
  view.unmount();
  mountSidebar();
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(["yesterday", "week"]));
  expect(JSON.parse(localStorage.getItem("openorc.layout")!).collapsed).toEqual(["day-open:week", "day-closed:today"]);
});

it("keeps the open thread in view inside a folded day without unfolding it", async () => {
  dayThreads();
  useRouter.setState({ route: { view: "thread", threadId: "older" } });
  mountSidebar();
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(["today", "yesterday", "older"]));
  expect(section("Older")).toBe("false");
  expect(screen.getByRole("button", { name: /Old notes/ }).getAttribute("aria-current")).toBe("page");
  expect(screen.queryByRole("button", { name: /This week's notes/ })).toBeNull();
});

it("leads with pinned threads however long ago they last worked", async () => {
  dayThreads();
  fixture.threads[3]!.pinnedAt = 1;
  mountSidebar();
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(["older", "today", "yesterday"]));
  expect(section("Pinned")).toBe("true");
  expect(screen.queryByRole("button", { name: "Older" })).toBeNull();
});

it("names each thread's project under its title, with its pull request at the end", async () => {
  dayThreads();
  fixture.threads[0] = { ...fixture.threads[0]!, prUrl: "https://github.com/acme/app/pull/8", prState: "merged" };
  mountSidebar();
  const row = await screen.findByRole("button", { name: /Today's notes/ });
  expect(row.querySelector(".thread-preview-project-name")?.textContent).toBe("First project");
  const pull = within(row).getByRole("img", { name: "Pull request #8, merged" });
  expect(pull.textContent).toBe("#8");
  expect(pull.getAttribute("class")).toContain("text-ok");
  expect(screen.getByRole("button", { name: /Yesterday's notes/ }).querySelector(".thread-preview-pull")).toBeNull();
});

it("sweeps a working thread's title and puts its spinner under the title line, where a parent's chevron sits above", async () => {
  dayThreads();
  fixture.threads[0] = { ...fixture.threads[0]!, activity: "running" };
  mountSidebar();
  const row = await screen.findByRole("button", { name: /Today's notes/ });
  expect(row.querySelector(".thread-preview-title")?.hasAttribute("data-working")).toBe(true);
  expect(row.querySelector(".thread-preview-heading [aria-label='Working']")).toBeNull();
  // The line right under the title: what its agent is doing when there is a headline, else its project.
  expect(row.querySelector(".thread-preview-heading")?.nextElementSibling?.querySelector(".thread-preview-working [aria-label='Working']")).not.toBeNull();
  const idle = await screen.findByRole("button", { name: /Yesterday's notes/ });
  expect(idle.querySelector(".thread-preview-title")?.hasAttribute("data-working")).toBe(false);
  expect(idle.querySelector(".thread-preview-working")).toBeNull();
});

it("reads on by itself until an open day is whole, then pages Older when asked", async () => {
  projectThreads();
  const base = fixture.threads[1]!;
  fixture.threads = [
    ...Array.from({ length: 15 }, (_, index) => ({ ...base, id: `today-${index}`, title: `Today ${index}`, projectId: index % 2 ? "one" : "two", lastActivityAt: Date.now() - (index + 1) * 1000 })),
    ...Array.from({ length: 30 }, (_, index) => ({ ...base, id: `old-${index}`, title: `Old ${index}`, lastActivityAt: ago(30) - index * 1000 })),
  ];
  const today = Array.from({ length: 15 }, (_, index) => `today-${index}`);
  const old = (count: number) => Array.from({ length: count }, (_, index) => `old-${index}`);
  mountSidebar();
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(today));
  expect(screen.queryByRole("button", { name: "Load more threads" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Older" }));
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual([...today, ...old(9)]));
  fireEvent.click(await screen.findByRole("button", { name: "Load more threads" }));
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual([...today, ...old(21)]));
  fireEvent.click(await screen.findByRole("button", { name: "Load more threads" }));
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual([...today, ...old(30)]));
  expect(screen.queryByRole("button", { name: "Load more threads" })).toBeNull();
});

it("keeps pinned and archived filters available", async () => {
  projectThreads();
  const base = fixture.threads[0]!;
  fixture.threads = [
    ...Array.from({ length: 14 }, (_, index) => ({ ...base, id: `new-${index}`, title: `New ${index}`, createdAt: index + 2, lastActivityAt: Date.now() - (20 - index) * 1000, pinnedAt: null })),
    { ...base, createdAt: 1, lastActivityAt: 1 },
    { ...base, id: "archived", title: "Archived notes", archivedAt: 20, createdAt: 16, pinnedAt: null },
    { ...base, id: "home", title: "Removed project notes", projectId: "removed", createdAt: 100 },
    { ...base, id: "rini-home", title: "Private companion", projectId: WORKSPACE_ID, createdAt: 101 },
  ];
  mountSidebar();
  await screen.findByRole("button", { name: /New 13/ });
  expect(screen.queryByRole("button", { name: /Removed project notes|Private companion/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^Filter threads/ }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Pinned threads" }));
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(["pinned"]));
  fireEvent.click(screen.getByRole("button", { name: /^Filter threads/ }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Archived threads" }));
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(["archived"]));
});

it("keeps snoozed threads in one shared section", async () => {
  projectThreads();
  const base = fixture.threads[0]!;
  fixture.threads = [
    { ...base, id: "running", title: "Older running thread", createdAt: 1, lastActivityAt: Date.now() - 1000, pinnedAt: null, activity: "running" },
    { ...base, id: "recent", title: "Newer recent thread", projectId: "two", createdAt: 3, pinnedAt: null },
    { ...base, id: "snoozed", title: "Snoozed thread", createdAt: 4, pinnedAt: null, snoozedUntil: Date.now() + 60_000 },
  ];
  mountSidebar();
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(["recent", "running"]));
  fireEvent.click(screen.getByRole("button", { name: "Snoozed 1" }));
  expect(useUi.getState().threadOrder).toEqual(["recent", "running", "snoozed"]);
});

async function editProjects() {
  fireEvent.click(screen.getByRole("button", { name: /^Filter threads/ }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit projects" }));
  return screen.findByRole("dialog", { name: "Edit projects" });
}

async function closeProjects(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit projects" })).toBeNull());
}

it("shows and hides projects, keeping the open conversation and scope", async () => {
  projectThreads();
  useLayout.setState({ projectId: "one" });
  useRouter.setState({ route: { view: "thread", threadId: "regular" } });
  mountSidebar();
  await screen.findByRole("button", { name: /Regular notes/ });
  const dialog = await editProjects();
  expect(
    within(dialog)
      .getAllByRole<HTMLInputElement>("switch")
      .map((toggle) => toggle.checked),
  ).toEqual([true, true, true]);
  fireEvent.click(within(dialog).getByRole("switch", { name: "First project" }));
  await closeProjects(dialog);
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(["other"]));
  expect(screen.queryByRole("button", { name: /Regular notes|Pinned notes|Snoozed notes/ })).toBeNull();
  expect(useRouter.getState().route).toEqual({ view: "thread", threadId: "regular" });
  expect(useLayout.getState().projectId).toBe("one");
  expect(JSON.parse(localStorage.getItem("openorc.layout") ?? "{}").hiddenProjects).toEqual(["one"]);
  const reopened = await editProjects();
  expect(within(reopened).getByRole<HTMLInputElement>("switch", { name: "First project" }).checked).toBe(false);
  fireEvent.click(within(reopened).getByRole("switch", { name: "First project" }));
  await closeProjects(reopened);
  expect(await screen.findByRole("button", { name: /Regular notes/ })).toBeTruthy();
  expect(useLayout.getState().hiddenProjects).toEqual([]);
});

it("keeps hidden projects out of pinned and archived threads", async () => {
  projectThreads();
  fixture.threads[3]!.pinnedAt = 1;
  const base = fixture.threads[0]!;
  fixture.threads.push({ ...base, id: "archived-one", title: "Hidden archived notes", archivedAt: 1 }, { ...base, id: "archived-two", title: "Other archived notes", projectId: "two", archivedAt: 1 });
  useLayout.setState({ hiddenProjects: ["one"] });
  mountSidebar();
  await screen.findByRole("button", { name: /Other notes/ });
  for (const filter of ["Pinned threads", "Archived threads", "Active threads"]) {
    fireEvent.click(screen.getByRole("button", { name: /^Filter threads/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: filter }));
    await screen.findByRole("button", { name: filter === "Archived threads" ? /Other archived notes/ : /Other notes/ });
    expect(screen.queryByRole("button", { name: /Regular notes|Pinned notes|Snoozed notes|Hidden archived notes/ })).toBeNull();
    expect(useLayout.getState().hiddenProjects).toEqual(["one"]);
  }
});

it("can hide every project including Workspace, then show one again", async () => {
  projectThreads();
  useLayout.setState({ hiddenProjects: [WORKSPACE_ID, "one", "two"] });
  mountSidebar();
  expect(await screen.findByText("All projects are hidden.")).toBeTruthy();
  expect(useUi.getState().threadOrder).toEqual([]);
  const dialog = await editProjects();
  expect(
    within(dialog)
      .getAllByRole<HTMLInputElement>("switch")
      .map((toggle) => toggle.checked),
  ).toEqual([false, false, false]);
  fireEvent.click(within(dialog).getByRole("switch", { name: "Second project" }));
  await closeProjects(dialog);
  expect(await screen.findByRole("button", { name: /Other notes/ })).toBeTruthy();
  expect(screen.queryByText("All projects are hidden.")).toBeNull();
  expect(useLayout.getState().hiddenProjects).toEqual([WORKSPACE_ID, "one"]);
});

it("finds projects, focuses one with Only, and changes visibility in bulk", async () => {
  projectThreads();
  mountSidebar();
  const dialog = await editProjects();
  expect(within(dialog).getByText("3 of 3 shown")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Show only First project" }));
  expect(
    within(dialog)
      .getAllByRole<HTMLInputElement>("switch")
      .map((toggle) => toggle.checked),
  ).toEqual([false, true, false]);
  expect(useLayout.getState().projectId).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Show all" }));
  expect(useLayout.getState().hiddenProjects).toEqual([]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Hide all" }));
  expect(within(dialog).getByText("0 of 3 shown")).toBeTruthy();
  const search = within(dialog).getByRole("textbox", { name: "Find a project" });
  fireEvent.change(search, { target: { value: "/projects/two" } });
  expect(within(dialog).getAllByRole("switch")).toHaveLength(1);
  expect(within(dialog).getByRole<HTMLInputElement>("switch", { name: "Second project" }).checked).toBe(false);
  fireEvent.click(within(dialog).getByRole("button", { name: "Show only Second project" }));
  expect(useLayout.getState().hiddenProjects).toEqual([WORKSPACE_ID, "one"]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Clear project search" }));
  expect(within(dialog).getAllByRole("switch")).toHaveLength(3);
  fireEvent.change(search, { target: { value: "no such project" } });
  expect(within(dialog).getByText("No projects found.")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit projects" })).toBeNull());
  const reopened = await editProjects();
  expect(within(reopened).getByRole<HTMLInputElement>("textbox", { name: "Find a project" }).value).toBe("");
  expect(within(reopened).getByRole<HTMLInputElement>("switch", { name: "Second project" }).checked).toBe(true);
});

it("prunes deleted thread folds while keeping live and project folds", async () => {
  projectThreads();
  const kept = fixture.threads[0]!.id;
  useLayout.setState({ collapsed: ["thread-open:deleted", `thread-closed:${kept}`, "project:kept"] });
  mountSidebar();
  await waitFor(() => expect(useLayout.getState().collapsed).not.toContain("thread-open:deleted"));
  expect(useLayout.getState().collapsed).toContain(`thread-closed:${kept}`);
  expect(useLayout.getState().collapsed).toContain("project:kept");
});
