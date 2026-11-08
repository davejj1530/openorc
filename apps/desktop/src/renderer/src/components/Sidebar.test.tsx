import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { defaultOrclingLook, WORKSPACE_ID, type RpcParams, type ThreadSummary } from "@openorc/protocol";

vi.hoisted(() => Object.assign(window, { openorc: { platform: "darwin" } }));

const fixture: {
  projects: { id: string; name: string; rootPath: string }[];
  threads: (Pick<ThreadSummary, "id" | "title" | "projectId" | "agent" | "activity" | "unread" | "session" | "pinnedAt" | "snoozedUntil" | "lastActivityAt"> &
    Partial<Pick<ThreadSummary, "createdAt" | "archivedAt" | "parentThreadId" | "parentRelation" | "subagent" | "prUrl" | "prState" | "workspaceMode" | "branch" | "owner">>)[];
  /** What the host says Resolved holds, when it says. */
  resolvedCount?: number;
  /** What Resolved holds in each project, when the count depends on the projects asked about. */
  resolvedByProject?: Record<string, number>;
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
    if (method === "threads.resolvedCount") {
      const counts = fixture.resolvedByProject;
      if (!counts) return fixture.resolvedCount;
      return ((params as RpcParams<"threads.resolvedCount">).projectIds ?? []).reduce((sum, id) => sum + (counts[id] ?? 0), 0);
    }
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

import { ALL_WORKSPACES, useLayout } from "../lib/layout";
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
  fixture.resolvedCount = undefined;
  fixture.resolvedByProject = undefined;
  localStorage.clear();
  useWindow.setState({ fullscreen: false });
  useLayout.setState({ collapsed: [], workspace: ALL_WORKSPACES, sidebarOpen: true, pinnedOnly: false, railProjects: false });
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

it("reaches the app's screens from the rail, marking the open one as current", () => {
  open("notes");
  const dock = screen.getByRole("navigation", { name: "Screens" });
  expect(
    within(dock)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label")),
  ).toEqual(["New thread", "Tasks", "Pull requests", "Schedules", "Orclings", "Show projects", "Settings"]);
  fireEvent.click(within(dock).getByRole("button", { name: "Schedules" }));
  expect(useRouter.getState().route).toEqual({ view: "scheduled" });
  expect(within(dock).getByRole("button", { name: "Schedules" }).getAttribute("aria-current")).toBe("page");
  expect(within(dock).getByRole("button", { name: "Tasks" }).getAttribute("aria-current")).toBeNull();
  expect(screen.queryByRole("button", { name: "More" })).toBeNull();
});

const openFilter = () => fireEvent.click(screen.getByRole("button", { name: /^Threads in / }));
const scope = (name: string) => screen.getAllByRole("menuitem").find((item) => item.querySelector(".sidebar-scope-name")?.textContent === name)!;
const chosen = (name: string) => scope(name).querySelector("[data-icon=Check]")?.classList.contains("text-accent-ink") ?? false;
/** The list head's New thread, beside the filter; the rail holds the other. */
const listNewThread = () => screen.getAllByRole("button", { name: "New thread" }).find((button) => !button.closest("nav"))!;

it("starts a new thread from the list head, and adds a project from the project filter", () => {
  open("notes");
  fireEvent.click(listNewThread());
  expect(useRouter.getState().route).toMatchObject({ view: "newthread" });
  openFilter();
  fireEvent.click(screen.getByRole("menuitem", { name: "Add project" }));
  expect(useUi.getState().importProject).toBe(true);
  act(() => useUi.getState().setImportProject(false));
});

it("offers All projects, then each project in the order projects come, with All projects chosen at first", () => {
  fixture.projects = [
    { id: "b8", name: "block8-workspace", rootPath: "/projects/b8" },
    { id: "gk", name: "gradekit", rootPath: "/projects/gk" },
    { id: "sma", name: "sma-2-mobile", rootPath: "/projects/sma" },
  ];
  mountSidebar();
  expect(screen.getByText("All projects", { selector: ".sidebar-workspace-name-label" })).toBeTruthy();
  openFilter();
  expect(screen.getAllByRole("menuitem").map((item) => item.querySelector(".sidebar-scope-name")?.textContent ?? item.textContent?.trim())).toEqual([
    "All projects",
    "block8-workspace",
    "gradekit",
    "sma-2-mobile",
    "Add project",
  ]);
  expect(["All projects", "block8-workspace", "gradekit", "sma-2-mobile"].map(chosen)).toEqual([true, false, false, false]);
  expect(screen.queryByRole("menuitem", { name: /Project settings/ })).toBeNull();
});

it("lists only the chosen project's threads, remembers the choice, starts new threads there, and counts its own Resolved", async () => {
  projectThreads();
  fixture.resolvedByProject = { one: 4, two: 2 };
  mountSidebar();
  await screen.findByRole("button", { name: /Other notes/ });
  expect(screen.getByRole("button", { name: "Resolved, 6" })).toBeTruthy();
  openFilter();
  fireEvent.click(scope("Second project"));
  expect(useLayout.getState().workspace).toBe("two");
  expect(JSON.parse(localStorage.getItem("openorc.layout") ?? "{}")).toMatchObject({ workspace: "two" });
  await waitFor(() => expect(screen.queryByRole("button", { name: /Regular notes/ })).toBeNull());
  expect(screen.getByRole("button", { name: /Other notes/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Resolved, 2" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Threads in Second project" })).toBeTruthy();
  fireEvent.click(listNewThread());
  expect(useRouter.getState().route).toEqual({ view: "newthread", projectId: "two" });
  openFilter();
  expect([chosen("Second project"), chosen("All projects")]).toEqual([true, false]);
  fireEvent.click(scope("All projects"));
  expect(useLayout.getState().workspace).toBe(ALL_WORKSPACES);
  await screen.findByRole("button", { name: /Regular notes/ });
});

it("opens the chosen project's settings from the project filter", () => {
  projectThreads();
  useLayout.setState({ workspace: "two" });
  mountSidebar();
  openFilter();
  fireEvent.click(screen.getByRole("menuitem", { name: "Project settings" }));
  expect(useRouter.getState().route).toEqual({ view: "project", projectId: "two" });
});

it("lists the projects in the rail under Projects, and chooses one there, the chosen one again going back to all of them", async () => {
  projectThreads();
  mountSidebar();
  const rail = () => screen.getByRole("navigation", { name: "Screens" });
  expect(within(rail()).queryByRole("list", { name: "Projects" })).toBeNull();
  fireEvent.click(within(rail()).getByRole("button", { name: "Show projects" }));
  expect(useLayout.getState().railProjects).toBe(true);
  const projects = () => within(rail()).getByRole("list", { name: "Projects" });
  await waitFor(() =>
    expect(
      within(projects())
        .getAllByRole("button")
        .map((tile) => tile.getAttribute("aria-label")),
    ).toEqual(["First project", "Second project"]),
  );
  // Add project sits under the projects' well, not among them.
  expect(within(rail()).getByRole("button", { name: "Add project" })).toBeTruthy();
  fireEvent.click(within(projects()).getByRole("button", { name: "Second project" }));
  expect(useLayout.getState().workspace).toBe("two");
  expect(within(projects()).getByRole("button", { name: "Second project" }).getAttribute("aria-current")).toBe("true");
  expect(screen.getByRole("button", { name: "Threads in Second project" })).toBeTruthy();
  fireEvent.click(within(projects()).getByRole("button", { name: "Second project" }));
  expect(useLayout.getState().workspace).toBe(ALL_WORKSPACES);
  fireEvent.click(within(rail()).getByRole("button", { name: "Hide projects" }));
  expect(within(rail()).queryByRole("list", { name: "Projects" })).toBeNull();
});

it("goes back to All when the chosen project is no longer listed", async () => {
  projectThreads();
  useLayout.setState({ workspace: "gone" });
  mountSidebar();
  await waitFor(() => expect(useLayout.getState().workspace).toBe(ALL_WORKSPACES));
});

it("marks each project in the filter with its most pressing open thread, sub threads included, and says what is there", async () => {
  fixture.projects = ["one", "two", "three", "four", "five"].map((id) => ({ id, name: `${id}-project`, rootPath: `/projects/${id}` }));
  const base = { agent: "codex", activity: "idle", unread: false, session: { status: "idle", message: null }, pinnedAt: null, snoozedUntil: null, lastActivityAt: Date.now() } as const;
  const failed = { status: "error", message: "Boom" } as const;
  fixture.threads = [
    { ...base, id: "one-unread", title: "One unread", projectId: "one", unread: true },
    { ...base, id: "one-parent", title: "One parent", projectId: "one", activity: "running" as const },
    { ...base, id: "one-child", title: "One child", projectId: "one", activity: "waiting" as const, parentThreadId: "one-parent", parentRelation: "started" as const },
    { ...base, id: "two-failed", title: "Two failed", projectId: "two", unread: true, session: failed },
    { ...base, id: "two-running", title: "Two running", projectId: "two", activity: "running" as const },
    { ...base, id: "three-running", title: "Three running", projectId: "three", activity: "running" as const },
    { ...base, id: "three-unread", title: "Three unread", projectId: "three", unread: true },
    { ...base, id: "four-unread", title: "Four unread", projectId: "four", unread: true },
    // Quiet since before yesterday: Resolved holds it, so its project stays unmarked.
    { ...base, id: "five-old", title: "Five old", projectId: "five", unread: true, lastActivityAt: ago(5) },
  ];
  mountSidebar();
  openFilter();
  const mark = (name: string) => scope(name).querySelector(".sidebar-scope-mark [role=img]")?.getAttribute("aria-label") ?? null;
  await waitFor(() => expect(mark("one-project")).toBe("Needs you"));
  expect(["two-project", "three-project", "four-project", "five-project"].map(mark)).toEqual(["Failed", "Working", "Unread", null]);
  expect(scope("All projects").querySelector(".sidebar-scope-mark")).toBeNull();
  expect(scope("one-project").getAttribute("aria-description")).toBe("1 needs you · 1 working · 1 unread");
  expect(scope("two-project").getAttribute("aria-description")).toBe("1 failed · 1 working");
  expect(scope("five-project").getAttribute("aria-description")).toBeNull();
});

it("lists Settings' sections in place of the thread list beside the rail, then goes back to the screen Settings was opened from", () => {
  useRouter.setState({ route: { view: "settings", section: "slack" }, history: [{ view: "tasks" }, { view: "settings" }] });
  mountSidebar();
  const sections = screen.getByRole("navigation", { name: "Settings" });
  expect(
    within(sections)
      .getAllByRole("button")
      .map((row) => row.textContent),
  ).toEqual(["Usage", "Connections", "Cloud", "Slack", "Phone", "Skills", "Connectors", "Devices", "Appearance", "General", "Memory & models", "Data"]);
  expect(within(sections).getByRole("button", { name: "Slack" }).getAttribute("aria-current")).toBe("page");
  // The rail stays, with the New thread the list's head would hold, and Settings as the current screen.
  const rail = screen.getByRole("navigation", { name: "Screens" });
  expect(
    within(rail)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"))
      .slice(0, 2),
  ).toEqual(["New thread", "Tasks"]);
  expect(within(rail).getByRole("button", { name: "Settings" }).getAttribute("aria-current")).toBe("page");
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
  expect(within(screen.getByRole("navigation", { name: "Screens" })).getByRole("button", { name: "New thread" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-current")).toBeNull();
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
    { id: "recent", title: "Recent notes", lastActivityAt: Date.now() - 1000 },
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
    ...Array.from({ length: 14 }, (_, index) => ({ ...base, id: `yesterday-${index}`, title: `Yesterday's notes ${index}`, projectId: "one", lastActivityAt: ago(1) - index })),
    { ...base, id: "waiting", title: "Waiting on you", projectId: "one", lastActivityAt: ago(1) - 100, activity: "waiting" as const },
    { ...base, id: "unread", title: "Unread result", projectId: "two", lastActivityAt: ago(1) - 1000, unread: true },
    { ...base, id: "quiet", title: "Quiet notes", projectId: "two", lastActivityAt: ago(1) - 1000 },
  ];
  mountSidebar();
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(["waiting", "unread"]));
  expect(screen.queryByRole("button", { name: /Quiet notes|Yesterday's notes 0/ })).toBeNull();
  expect(["Yesterday", "Resolved"].map(section)).toEqual(["false", "false"]);
});

it("lists the last hours' threads, then yesterday folded and the rest in Resolved, hides an empty day, and keeps the reader's folds", async () => {
  dayThreads();
  const view = mountSidebar();
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(["recent"]));
  expect(["Recent", "Yesterday", "Resolved"].map(section)).toEqual(["true", "false", "false"]);
  expect(screen.queryByRole("button", { name: "Last 7 days" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Today" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Yesterday's notes|This week's notes|Old notes/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Yesterday" }));
  expect(useUi.getState().threadOrder).toEqual(["recent", "yesterday"]);
  fireEvent.click(screen.getByRole("button", { name: "Recent" }));
  expect(useUi.getState().threadOrder).toEqual(["yesterday"]);
  view.unmount();
  mountSidebar();
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(["yesterday"]));
  expect(JSON.parse(localStorage.getItem("openorc.layout")!).collapsed).toEqual(["day-open:yesterday", "day-closed:recent"]);
});

it("keeps the open thread in view inside a folded Resolved without unfolding it", async () => {
  dayThreads();
  useRouter.setState({ route: { view: "thread", threadId: "older" } });
  mountSidebar();
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(["recent", "older"]));
  expect(section("Resolved")).toBe("false");
  expect(screen.getByRole("button", { name: /Old notes/ }).getAttribute("aria-current")).toBe("page");
  expect(screen.queryByRole("button", { name: /This week's notes/ })).toBeNull();
});

it("leads with pinned threads however long ago they last worked", async () => {
  dayThreads();
  fixture.threads[3]!.pinnedAt = 1;
  useLayout.setState({ collapsed: ["resolved-open:threads"] });
  mountSidebar();
  // The old pin leads, and Resolved holds only what no pin keeps out.
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(["older", "recent", "week"]));
  expect(section("Pinned")).toBe("true");
  expect(screen.getAllByRole("button", { name: /Old notes/ })).toHaveLength(1);
});

it("names each thread's project under its title, with its pull request at the end", async () => {
  dayThreads();
  fixture.threads[0] = { ...fixture.threads[0]!, prUrl: "https://github.com/acme/app/pull/8", prState: "merged" };
  useLayout.setState({ collapsed: ["day-open:yesterday"] });
  mountSidebar();
  const row = await screen.findByRole("button", { name: /Recent notes/ });
  expect(row.querySelector(".thread-preview-project-name")?.textContent).toBe("First project");
  const pull = within(row).getByRole("img", { name: "Pull request #8, merged" });
  expect(pull.textContent).toBe("#8");
  expect(pull.getAttribute("class")).toContain("text-ok");
  expect(screen.getByRole("button", { name: /Yesterday's notes/ }).querySelector(".thread-preview-pull")).toBeNull();
});

it("says after the project where each thread works, and leaves it to a pull request unless that is the cloud", async () => {
  dayThreads();
  const [recent, yesterday, week, older] = fixture.threads;
  const pull = { prUrl: "https://github.com/acme/app/pull/8", prState: "open" } as const;
  fixture.threads = [
    { ...recent!, workspaceMode: "current", branch: "main" },
    { ...yesterday!, workspaceMode: "worktree", branch: "openorc/notes-a1b2c3" },
    { ...week!, workspaceMode: "worktree", branch: "openorc/week-d4e5f6", ...pull },
    { ...older!, workspaceMode: "worktree", branch: "openorc/old-g7h8i9", ...pull, owner: { brain: "cloud", reach: "live", heardAt: 1 } },
  ];
  useLayout.setState({ collapsed: ["day-open:yesterday", "resolved-open:threads"] });
  mountSidebar();
  const workspace = async (name: RegExp) => (await screen.findByRole("button", { name })).querySelector(".thread-preview-workspace");
  expect((await workspace(/Recent notes/))?.textContent).toBe("main");
  expect(await workspace(/Yesterday's notes/)).toMatchObject({ textContent: "worktree", title: "openorc/notes-a1b2c3" });
  expect(await workspace(/This week's notes/)).toBeNull();
  expect((await workspace(/Old notes/))?.textContent).toBe("cloud");
});

it("sweeps a working thread's title and puts its spinner under the title line, where a parent's chevron sits above", async () => {
  dayThreads();
  fixture.threads[0] = { ...fixture.threads[0]!, activity: "running" };
  useLayout.setState({ collapsed: ["day-open:yesterday"] });
  mountSidebar();
  const row = await screen.findByRole("button", { name: /Recent notes/ });
  expect(row.querySelector(".thread-preview-title")?.hasAttribute("data-working")).toBe(true);
  expect(row.querySelector(".thread-preview-heading [aria-label='Working']")).toBeNull();
  // The line right under the title: what its agent is doing when there is a headline, else its project.
  expect(row.querySelector(".thread-preview-heading")?.nextElementSibling?.querySelector(".thread-preview-mark [aria-label='Working']")).not.toBeNull();
  const idle = await screen.findByRole("button", { name: /Yesterday's notes/ });
  expect(idle.querySelector(".thread-preview-title")?.hasAttribute("data-working")).toBe(false);
  expect(idle.querySelector(".thread-preview-mark > *")).toBeNull();
});

it("puts what a thread needs from you where the spinner goes, under the title line", async () => {
  dayThreads();
  fixture.threads[0] = { ...fixture.threads[0]!, activity: "waiting" };
  useLayout.setState({ collapsed: ["day-open:yesterday"] });
  mountSidebar();
  const row = await screen.findByRole("button", { name: /Recent notes/ });
  expect(row.querySelector(".thread-preview-heading [aria-label='Needs you']")).toBeNull();
  expect(row.querySelector(".thread-preview-heading")?.nextElementSibling?.querySelector(".thread-preview-mark [aria-label='Needs you']")).not.toBeNull();
});

it("reads on by itself until an open day is whole, then pages Resolved when asked", async () => {
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
  fireEvent.click(screen.getByRole("button", { name: "Resolved" }));
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual([...today, ...old(9)]));
  fireEvent.click(await screen.findByRole("button", { name: "Load more threads" }));
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual([...today, ...old(21)]));
  fireEvent.click(await screen.findByRole("button", { name: "Load more threads" }));
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual([...today, ...old(30)]));
  expect(screen.queryByRole("button", { name: "Load more threads" })).toBeNull();
});

it("keeps the pinned filter, and lists resolved threads in Resolved rather than a filter", async () => {
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
  expect(screen.queryByRole("button", { name: "Resolved" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^Filter threads/ }));
  expect(screen.queryByRole("menuitem", { name: /Archived/ })).toBeNull();
  fireEvent.click(await screen.findByRole("menuitem", { name: "All threads" }));
  await screen.findByRole("button", { name: /New 13/ });
  expect(screen.queryByRole("button", { name: /Archived notes/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Resolved" }));
  await screen.findByRole("button", { name: /Archived notes/ });
  expect(useUi.getState().threadOrder.at(-1)).toBe("archived");
});

/** A drag as the browser carries it, for jsdom, which has no DataTransfer. */
function dragData() {
  const data = new Map<string, string>();
  return {
    effectAllowed: "all",
    dropEffect: "none",
    get types() {
      return [...data.keys()];
    },
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
  };
}

it("resolves a thread dropped on Resolved and reopens a resolved one dropped on the list", async () => {
  dayThreads();
  useLayout.setState({ collapsed: ["resolved-open:threads"] });
  mountSidebar();
  fixture.resolvedCount = 2;
  const drawer = (await screen.findByRole("button", { name: "Resolved, 2" })).parentElement!;
  await screen.findByRole("button", { name: /Old notes/ });
  const drag = (name: RegExp, onto: Element) => {
    const dataTransfer = dragData();
    fireEvent.dragStart(screen.getByRole("button", { name }), { dataTransfer });
    fireEvent.dragOver(onto, { dataTransfer });
    fireEvent.drop(onto, { dataTransfer });
    fireEvent.dragEnd(screen.getByRole("button", { name }), { dataTransfer });
  };
  const updates = () =>
    vi
      .mocked(core.call)
      .mock.calls.filter(([method]) => method === "threads.update")
      .map(([, params]) => params);
  // Held over Resolved, the count takes the thread in before it lands.
  const dataTransfer = dragData();
  fireEvent.dragStart(screen.getByRole("button", { name: /Recent notes/ }), { dataTransfer });
  fireEvent.dragOver(drawer, { dataTransfer });
  expect(screen.getByRole("button", { name: "Resolved, 3" })).toBeTruthy();
  fireEvent.dragLeave(drawer, { dataTransfer, relatedTarget: document.body });
  fireEvent.dragEnd(screen.getByRole("button", { name: /Recent notes/ }), { dataTransfer });
  expect(screen.getByRole("button", { name: "Resolved, 2" })).toBeTruthy();
  drag(/Recent notes/, drawer);
  await waitFor(() => expect(updates()).toEqual([{ id: "recent", patch: { archived: true } }]));
  // Dropped back on Resolved, a resolved thread stays as it is; on the list it comes back.
  drag(/Old notes/, drawer);
  drag(/Old notes/, document.querySelector(".browser-threads")!);
  await waitFor(() =>
    expect(updates()).toEqual([
      { id: "recent", patch: { archived: true } },
      { id: "older", patch: { archived: false } },
    ]),
  );
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

it("prunes deleted thread folds while keeping live and project folds", async () => {
  projectThreads();
  const kept = fixture.threads[0]!.id;
  useLayout.setState({ collapsed: ["thread-open:deleted", `thread-closed:${kept}`, "project:kept"] });
  mountSidebar();
  await waitFor(() => expect(useLayout.getState().collapsed).not.toContain("thread-open:deleted"));
  expect(useLayout.getState().collapsed).toContain(`thread-closed:${kept}`);
  expect(useLayout.getState().collapsed).toContain("project:kept");
});

it("keeps the rail while the sidebar is hidden, with New thread at its top for the focused project", () => {
  fixture.projects = [{ id: "notes", name: "notes", rootPath: "/projects/notes" }];
  useLayout.setState({ sidebarOpen: false, workspace: "notes" });
  useRouter.setState({ route: { view: "tasks" }, history: [], future: [], threadIds: [] });
  mountSidebar();
  const rail = screen.getByRole("navigation", { name: "Screens" });
  expect(rail.closest("[inert]")).toBeNull();
  const buttons = within(rail)
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label"));
  expect(buttons.slice(0, 2)).toEqual(["New thread", "Tasks"]);
  fireEvent.click(within(rail).getByRole("button", { name: "New thread" }));
  expect(useRouter.getState().route).toMatchObject({ view: "newthread", projectId: "notes" });
});

it("keeps New thread on the rail and beside the filter at the end of the list's head", () => {
  mountSidebar();
  expect(within(screen.getByRole("navigation", { name: "Screens" })).getByRole("button", { name: "New thread" })).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "New thread" })).toHaveLength(2);
  const head = screen.getByRole("button", { name: "Search" }).parentElement!;
  expect(
    within(head)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent),
  ).toEqual(["Search", "Filter threads", "New thread"]);
});
