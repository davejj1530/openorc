import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { defaultOrclingLook, WORKSPACE_ID, type RpcParams, type ThreadSummary } from "@openorc/protocol";

vi.hoisted(() => Object.assign(window, { openorc: { platform: "darwin" } }));

const fixture: {
  projects: { id: string; name: string; rootPath: string }[];
  threads: (Pick<ThreadSummary, "id" | "title" | "projectId" | "agent" | "activity" | "unread" | "session" | "pinnedAt" | "snoozedUntil" | "lastActivityAt"> &
    Partial<Pick<ThreadSummary, "createdAt" | "archivedAt" | "parentThreadId" | "parentRelation" | "subagent" | "prUrl" | "prState" | "workspaceMode" | "branch" | "owner">>)[];
  tasks?: { status: string; approval?: string }[];
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
    if (method === "tasks.list") return fixture.tasks;
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
vi.mock("./ui", async (importOriginal) => {
  const { cloneElement } = await import("react");
  return {
    ...(await importOriginal<typeof import("./ui")>()),
    Tooltip: ({ children, render }: { children: ReactNode; render?: ReactElement }) => (render ? cloneElement(render, undefined, children) : children),
  };
});

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
  fixture.tasks = undefined;
  localStorage.clear();
  useWindow.setState({ fullscreen: false });
  useLayout.setState({ collapsed: [], workspace: ALL_WORKSPACES, sidebarOpen: true, pinnedOnly: false });
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

it("heads the sidebar with OpenOrc's mark and name alone, and leads the screens with New thread, lit while its screen is open", () => {
  fixture.projects = [{ id: "notes", name: "notes", rootPath: "/projects/notes" }];
  useLayout.setState({ workspace: "notes" });
  useRouter.setState({ route: { view: "tasks" } });
  mountSidebar();
  const header = screen.getByRole("img", { name: "OpenOrc" }).closest("header")!;
  expect(screen.getByRole("img", { name: "OpenOrc" }).textContent).toBe("OpenOrc");
  expect(screen.queryByRole("group", { name: "Window" })).toBeNull();
  expect(
    within(header)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label")),
  ).toEqual(["Toggle sidebar"]);
  const screens = screen.getByRole("navigation", { name: "Screens" });
  const newThread = within(screens).getAllByRole("button")[0]!;
  expect(newThread.textContent).toBe("New thread");
  expect(newThread.getAttribute("aria-current")).toBeNull();
  fireEvent.click(newThread);
  expect(useRouter.getState().route).toEqual({ view: "newthread", projectId: "notes" });
  expect(newThread.getAttribute("aria-current")).toBe("page");
  act(() => useWindow.setState({ fullscreen: true }));
  expect(screen.getAllByRole("img", { name: "OpenOrc" })).toHaveLength(1);
});

it("heads Workspaces with Add project alone until there is a project", () => {
  mountSidebar();
  const head = screen.getByRole("button", { name: "Add project" }).parentElement!;
  expect(
    within(head)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label")),
  ).toEqual(["Add project"]);
});

it("heads Workspaces with the app's one search, Add project and the filter", () => {
  fixture.projects = [{ id: "notes", name: "notes", rootPath: "/projects/notes" }];
  mountSidebar();
  const head = screen.getByRole("button", { name: "Search" }).parentElement!;
  expect(
    within(head)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label")),
  ).toEqual(["Search", "Add project", "Filter threads"]);
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(useUi.getState()).toMatchObject({ palette: true, paletteMode: "all" });
});

const screens = () => screen.getByRole("navigation", { name: "Screens" });

it("switches between project threads and Orclings with the Orclings row, remembering the project thread", () => {
  open("notes");
  expect(screen.getByRole("region", { name: "Workspaces" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Orclings" })).toBeNull();
  const orclings = () => within(screens()).getByRole("button", { name: "Orclings" });
  expect(orclings().getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(orclings());
  expect(useRouter.getState().route).toEqual({ view: "thread", threadId: "rini-home" });
  expect(screen.queryByRole("region", { name: "Workspaces" })).toBeNull();
  expect(screen.getByRole("region", { name: "Orclings" })).toBeTruthy();
  expect(orclings().getAttribute("aria-pressed")).toBe("true");
  // Their row names them once and carries their tools; the list has no head repeating the name.
  expect(within(screens()).getByRole("button", { name: "New Orcling" })).toBeTruthy();
  expect(screen.getAllByText("Orclings")).toHaveLength(1);
  fireEvent.click(orclings());
  expect(useRouter.getState().route).toEqual({ view: "thread", threadId: "notes" });
  expect(screen.getByRole("region", { name: "Workspaces" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Orclings" })).toBeNull();
});

it("opens project conversations when Orclings is turned off from an initial Orcling chat", () => {
  open("rini-home");
  fireEvent.click(within(screens()).getByRole("button", { name: "Orclings" }));
  expect(useRouter.getState().route).toMatchObject({ view: "newthread" });
  expect(screen.queryByRole("region", { name: "Orclings" })).toBeNull();
});

it("names the app's screens as rows after New thread, each with its icon, marking the open one as current", () => {
  open("notes");
  expect(
    within(screens())
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["New thread", "Tasks", "Pull requests", "Schedules", "Orclings"]);
  expect(
    within(screens())
      .getAllByRole("button")
      .every((row) => row.querySelector("svg")),
  ).toBe(true);
  fireEvent.click(within(screens()).getByRole("button", { name: "Schedules" }));
  expect(useRouter.getState().route).toEqual({ view: "scheduled" });
  expect(within(screens()).getByRole("button", { name: "Schedules" }).getAttribute("aria-current")).toBe("page");
  expect(within(screens()).getByRole("button", { name: "Tasks" }).getAttribute("aria-current")).toBeNull();
});

it("counts on Tasks only what waits on the person: a run's approval, a proposal or a review, and keeps no Inbox", () => {
  fixture.tasks = [{ status: "review" }, { status: "proposed" }, { status: "backlog" }, { status: "in_progress", approval: "Run pnpm install" }, { status: "in_progress" }];
  mountSidebar();
  const tasks = within(screens()).getByRole("button", { name: "Tasks, 3 waiting" });
  expect(tasks.textContent).toBe("Tasks3");
  expect(within(screens()).getByRole("button", { name: "Schedules" }).querySelector(".sidebar-count")).toBeNull();
  expect(screen.queryByRole("button", { name: /^Inbox/ })).toBeNull();
  fireEvent.click(tasks);
  expect(useRouter.getState().route).toEqual({ view: "tasks" });
  expect(within(screens()).getByRole("button", { name: "Tasks, 3 waiting" }).getAttribute("aria-current")).toBe("page");
});

it("caps a screen's count at 99+", () => {
  fixture.tasks = Array.from({ length: 120 }, () => ({ status: "review" }));
  mountSidebar();
  expect(within(screens()).getByRole("button", { name: "Tasks, 120 waiting" }).querySelector(".sidebar-count")?.textContent).toBe("99+");
});

const group = (name: string) => screen.getByRole("region", { name });
const label = (name: string) => within(group(name)).getAllByRole("button")[0]!;
const rowTitles = (region: HTMLElement) => [...region.querySelectorAll(".thread-preview-title")].map((title) => title.textContent);

it("groups the threads under each project in the order projects come, an empty project too, with no project line on the rows", async () => {
  projectThreads();
  fixture.projects.push({ id: "three", name: "Third project", rootPath: "/projects/three" });
  mountSidebar();
  await screen.findByRole("button", { name: /Other notes/ });
  expect([...document.querySelectorAll(".sidebar-project")].map((section) => section.getAttribute("aria-label"))).toEqual(["First project", "Second project", "Third project"]);
  expect(rowTitles(group("First project"))).toEqual(["Regular notes"]);
  expect(rowTitles(group("Second project"))).toEqual(["Other notes"]);
  expect(rowTitles(group("Third project"))).toEqual([]);
  expect(group("First project").querySelector(".thread-preview-project")).toBeNull();
  // Pinned threads lead in their own group, naming their project; No project shows only once it holds threads.
  expect(rowTitles(screen.getByRole("button", { name: "Pinned" }).closest(".sidebar-section") as HTMLElement)).toEqual(["Pinned notes"]);
  expect(screen.getByRole("button", { name: /Pinned notes/ }).querySelector(".thread-preview-project")?.textContent).toBe("First project");
  expect(screen.queryByRole("region", { name: "No project" })).toBeNull();
});

it("starts a new thread in a project from its label, and adds a project from the Workspaces head, its one way in", async () => {
  projectThreads();
  mountSidebar();
  fireEvent.click(await screen.findByRole("button", { name: "New thread in Second project" }));
  expect(useRouter.getState().route).toEqual({ view: "newthread", projectId: "two" });
  expect(screen.getAllByRole("button", { name: "Add project" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Add project" }));
  expect(useUi.getState().importProject).toBe(true);
  act(() => useUi.getState().setImportProject(false));
});

it("reads No projects yet with no projects, keeping Add project in the head", async () => {
  mountSidebar();
  expect(await screen.findByText("No projects yet.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add project" }));
  expect(useUi.getState().importProject).toBe(true);
  act(() => useUi.getState().setImportProject(false));
});

it("leads each project's label with its mark, and No project's with the globe", async () => {
  projectThreads();
  fixture.threads.push({ ...fixture.threads[0]!, id: "loose", title: "Loose notes", projectId: WORKSPACE_ID, pinnedAt: null });
  mountSidebar();
  await screen.findByRole("button", { name: /Loose notes/ });
  for (const name of ["First project", "Second project", "No project"]) {
    const mark = label(name).firstElementChild!;
    expect(mark.classList.contains("sidebar-project-mark")).toBe(true);
    expect(mark.querySelector("svg, img")).not.toBeNull();
  }
  expect(label("No project").querySelector('.sidebar-project-mark [data-icon="Globe"]')).not.toBeNull();
  expect(label("First project").querySelector('.sidebar-project-mark [data-icon="Folder"]')).not.toBeNull();
});

it("reaches a project's actions from a button at its label's end, with the keyboard as with a click", async () => {
  projectThreads();
  mountSidebar();
  await screen.findByRole("button", { name: /Other notes/ });
  const more = screen.getByRole("button", { name: "More for Second project" });
  more.focus();
  expect(document.activeElement).toBe(more);
  fireEvent.click(more);
  expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent?.trim())).toEqual(["New thread", "New task", "Choose icon…", "Project settings", "Remove project…"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Project settings" }));
  expect(useRouter.getState().route).toEqual({ view: "project", projectId: "two" });
});

it("opens a project's own actions from a right click on its label", async () => {
  projectThreads();
  mountSidebar();
  await screen.findByRole("button", { name: /Other notes/ });
  fireEvent.contextMenu(label("Second project"));
  expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent?.trim())).toEqual(["New thread", "New task", "Choose icon…", "Project settings", "Remove project…"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Project settings" }));
  expect(useRouter.getState().route).toEqual({ view: "project", projectId: "two" });
});

it("folds a project's group and keeps the fold, holding the open thread, and counts what in it waits on the person", async () => {
  projectThreads();
  fixture.threads.push({ ...fixture.threads[1]!, id: "asks", title: "Asks you", activity: "waiting" }, { ...fixture.threads[1]!, id: "works", title: "Works", activity: "running" });
  useRouter.setState({ route: { view: "thread", threadId: "regular" } });
  const view = mountSidebar();
  await screen.findByRole("button", { name: /Other notes/ });
  expect(label("First project").getAttribute("aria-label")).toBe("First project, 1 waiting");
  expect(label("Second project").getAttribute("aria-label")).toBe("Second project");
  fireEvent.click(label("First project"));
  expect(label("First project").getAttribute("aria-expanded")).toBe("false");
  expect(rowTitles(group("First project"))).toEqual(["Regular notes"]);
  expect(useLayout.getState().collapsed).toContain("project:one");
  view.unmount();
  mountSidebar();
  await screen.findByRole("button", { name: /Other notes/ });
  expect(label("First project").getAttribute("aria-expanded")).toBe("false");
});

it("pages a long group with Show N more", async () => {
  projectThreads();
  const base = fixture.threads[3]!;
  fixture.threads = Array.from({ length: 17 }, (_, index) => ({ ...base, id: `t${index}`, title: `Thread ${index}`, lastActivityAt: Date.now() - index * 1000 }));
  mountSidebar();
  await screen.findByRole("button", { name: /Thread 0/ });
  expect(rowTitles(group("Second project"))).toHaveLength(4);
  fireEvent.click(within(group("Second project")).getByRole("button", { name: "Show 13 more" }));
  expect(rowTitles(group("Second project"))).toHaveLength(14);
  fireEvent.click(within(group("Second project")).getByRole("button", { name: "Show 3 more" }));
  expect(rowTitles(group("Second project"))).toHaveLength(17);
  expect(within(group("Second project")).queryByRole("button", { name: /^Show \d+ more$/ })).toBeNull();
});

it("folds Workspaces as a whole, counting what waits inside only while folded, and keeps the fold", async () => {
  projectThreads();
  fixture.threads[3] = { ...fixture.threads[3]!, activity: "waiting" };
  const view = mountSidebar();
  await screen.findByRole("button", { name: /Other notes/ });
  const fold = () => within(screen.getByRole("region", { name: "Workspaces" })).getAllByRole("button")[0]!;
  expect(fold().textContent).toBe("Workspaces");
  fireEvent.click(fold());
  expect(fold().getAttribute("aria-expanded")).toBe("false");
  expect(fold().getAttribute("aria-label")).toBe("Workspaces, 1 waiting");
  expect(screen.queryByRole("button", { name: /Other notes/ })).toBeNull();
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual([]));
  view.unmount();
  mountSidebar();
  expect(fold().getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(fold());
  await screen.findByRole("button", { name: /Other notes/ });
});

it("goes back to All projects when the chosen project is no longer listed", async () => {
  projectThreads();
  useLayout.setState({ workspace: "gone" });
  mountSidebar();
  await waitFor(() => expect(useLayout.getState().workspace).toBe(ALL_WORKSPACES));
});

it("lists Settings' sections in place of the screens and threads, then goes back to the screen Settings was opened from", () => {
  useRouter.setState({ route: { view: "settings", section: "slack" }, history: [{ view: "tasks" }, { view: "settings" }] });
  mountSidebar();
  const sections = screen.getByRole("navigation", { name: "Settings" });
  expect(
    within(sections)
      .getAllByRole("button")
      .map((row) => row.textContent),
  ).toEqual(["Usage", "Connections", "Account", "Cloud", "Slack", "Phone", "Skills", "Connectors", "Devices", "Appearance", "General", "Memory & models", "Data"]);
  expect(within(sections).getByRole("button", { name: "Slack" }).getAttribute("aria-current")).toBe("page");
  expect(screen.queryByRole("navigation", { name: "Screens" })).toBeNull();
  expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-current")).toBe("page");
  // The thread list waits underneath, so its loaded pages and scroll survive the visit.
  expect(screen.getByRole("region", { name: "Workspaces", hidden: true })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Workspaces" })).toBeNull();

  fireEvent.click(within(sections).getByRole("button", { name: "Appearance" }));
  expect(useRouter.getState().route).toEqual({ view: "settings", section: "appearance" });

  fireEvent.click(screen.getByRole("button", { name: "Back to app" }));
  expect(useRouter.getState().route).toEqual({ view: "tasks" });
  expect(screen.queryByRole("navigation", { name: "Settings" })).toBeNull();
  expect(screen.getByRole("navigation", { name: "Screens" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-current")).toBeNull();
});

it("goes back to a new thread when Settings was opened first", () => {
  useRouter.setState({ route: { view: "settings" } });
  mountSidebar();
  fireEvent.click(screen.getByRole("button", { name: "Back to app" }));
  expect(useRouter.getState().route).toEqual({ view: "newthread" });
});

it("keeps Settings in the footer, under the list, and no update while none waits", () => {
  mountSidebar();
  const footer = screen.getByRole("contentinfo");
  expect(
    within(footer)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label")),
  ).toEqual(["Settings"]);
});

it.each([
  ["Schedules", "scheduled"],
  ["Settings", "settings"],
])("dismisses compact navigation after choosing %s", (name, destination) => {
  const matchMedia = window.matchMedia;
  window.matchMedia = (query) => ({ ...matchMedia(query), matches: query === "(max-width: 900px)" });
  try {
    useRouter.setState({ history: [{ view: "tasks" }], future: [{ view: "settings" }] });
    mountSidebar();
    fireEvent.click(screen.getByRole("button", { name }));
    expect(useRouter.getState().route.view).toBe(destination);
    expect(useLayout.getState().sidebarOpen).toBe(false);
  } finally {
    window.matchMedia = matchMedia;
  }
});

it("leaves nothing of itself to reach or read while hidden", () => {
  useLayout.setState({ sidebarOpen: false });
  mountSidebar();
  const aside = document.querySelector("aside")!;
  expect(aside.getAttribute("aria-hidden")).toBe("true");
  expect(aside.hasAttribute("inert")).toBe(true);
  expect(screen.queryByRole("navigation", { name: "Screens" })).toBeNull();
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

it("keeps a project's waiting threads in its count past the loaded pages", async () => {
  fixture.projects = [
    { id: "one", name: "First project", rootPath: "/projects/one" },
    { id: "two", name: "Second project", rootPath: "/projects/two" },
  ];
  const base = { agent: "codex", activity: "idle", unread: false, session: { status: "idle", message: null }, pinnedAt: null, snoozedUntil: null } as const;
  fixture.threads = [
    ...Array.from({ length: 14 }, (_, index) => ({ ...base, id: `yesterday-${index}`, title: `Yesterday's notes ${index}`, projectId: "one", lastActivityAt: ago(1) - index })),
    { ...base, id: "waiting", title: "Waiting on you", projectId: "one", lastActivityAt: ago(1) - 100, activity: "waiting" as const },
    { ...base, id: "asks", title: "Asks a question", projectId: "two", lastActivityAt: ago(1) - 1000, activity: "waiting" as const },
    { ...base, id: "unread", title: "Unread result", projectId: "two", lastActivityAt: ago(1) - 2000, unread: true },
  ];
  useLayout.setState({ collapsed: ["project:one", "project:two"] });
  mountSidebar();
  await waitFor(() => expect(label("First project").getAttribute("aria-label")).toBe("First project, 1 waiting"));
  expect(label("Second project").getAttribute("aria-label")).toBe("Second project, 1 waiting");
  expect(useUi.getState().threadOrder).toEqual([]);
});

it("lists every thread from the last day and yesterday in its project, and the older ones in Resolved", async () => {
  dayThreads();
  mountSidebar();
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(["recent", "yesterday"]));
  expect(section("Resolved")).toBe("false");
  expect(screen.queryByRole("button", { name: /This week's notes|Old notes/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Recent" })).toBeNull();
});

it("keeps the open thread in view inside a folded Resolved without unfolding it", async () => {
  dayThreads();
  useRouter.setState({ route: { view: "thread", threadId: "older" } });
  mountSidebar();
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(["recent", "yesterday", "older"]));
  expect(section("Resolved")).toBe("false");
  expect(screen.getByRole("button", { name: /Old notes/ }).getAttribute("aria-current")).toBe("page");
  expect(screen.queryByRole("button", { name: /This week's notes/ })).toBeNull();
});

it("leads with pinned threads however long ago they last worked", async () => {
  dayThreads();
  fixture.threads[3]!.pinnedAt = 1;
  useLayout.setState({ collapsed: ["resolved-open:threads"] });
  mountSidebar();
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(["older", "recent", "yesterday", "week"]));
  expect(section("Pinned")).toBe("true");
  expect(screen.getAllByRole("button", { name: /Old notes/ })).toHaveLength(1);
});

it("puts where each thread works on its second line, its pull request at the end, and no word of what its agent is doing", async () => {
  dayThreads();
  const [recent, yesterday] = fixture.threads;
  fixture.threads = [
    { ...recent!, workspaceMode: "current", branch: "main", activity: "running" },
    { ...yesterday!, workspaceMode: "worktree", branch: "openorc/notes-a1b2c3", prUrl: "https://github.com/acme/app/pull/8", prState: "merged" },
  ];
  mountSidebar();
  const line = async (name: RegExp) => (await screen.findByRole("button", { name })).querySelector(".thread-preview-line")!;
  expect((await line(/Recent notes/)).textContent).toBe("main");
  const worktree = await line(/Yesterday's notes/);
  expect(worktree.querySelector(".thread-preview-workspace")).toMatchObject({ textContent: "worktree", dataset: { tip: "openorc/notes-a1b2c3" } });
  const pull = within(worktree as HTMLElement).getByRole("img", { name: "Pull request #8, merged" });
  expect(pull.textContent).toBe("#8");
  expect(pull.getAttribute("class")).toContain("text-ok");
  expect(screen.getByRole("button", { name: /Recent notes/ }).querySelector(".thread-preview-headline")).toBeNull();
});

it("ends the title line with what the thread needs or is doing, and sweeps a working title", async () => {
  dayThreads();
  fixture.threads[0] = { ...fixture.threads[0]!, activity: "running" };
  fixture.threads[1] = { ...fixture.threads[1]!, activity: "waiting" };
  mountSidebar();
  const row = await screen.findByRole("button", { name: /Recent notes/ });
  expect(row.querySelector(".thread-preview-title")?.hasAttribute("data-working")).toBe(true);
  expect(row.querySelector(".thread-preview-heading > .thread-preview-mark [aria-label='Working']")).not.toBeNull();
  const asking = screen.getByRole("button", { name: /Yesterday's notes/ });
  expect(asking.querySelector(".thread-preview-heading > .thread-preview-mark [aria-label='Needs you']")).not.toBeNull();
  expect(asking.querySelector(".thread-preview-title")?.hasAttribute("data-working")).toBe(false);
});

it("reads on by itself until every group is whole, then pages Resolved when asked", async () => {
  projectThreads();
  const base = fixture.threads[1]!;
  fixture.threads = [
    ...Array.from({ length: 15 }, (_, index) => ({ ...base, id: `today-${index}`, title: `Today ${index}`, projectId: index % 2 ? "one" : "two", lastActivityAt: Date.now() - (index + 1) * 1000 })),
    ...Array.from({ length: 30 }, (_, index) => ({ ...base, id: `old-${index}`, title: `Old ${index}`, lastActivityAt: ago(30) - index * 1000 })),
  ];
  const shown = (project: number) => Array.from({ length: 15 }, (_, index) => `today-${index}`).filter((_, index) => index % 2 === project);
  const today = [...shown(1).slice(0, 4), ...shown(0).slice(0, 4)];
  const old = (count: number) => Array.from({ length: count }, (_, index) => `old-${index}`);
  mountSidebar();
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(today));
  expect(within(group("First project")).getByRole("button", { name: "Show 3 more" })).toBeTruthy();
  expect(within(group("Second project")).getByRole("button", { name: "Show 4 more" })).toBeTruthy();
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
  expect(screen.queryByRole("region", { name: "First project" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^Filter threads/ }));
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
  const toggle = await screen.findByRole("button", { name: "Resolved" });
  expect(toggle.textContent).toBe("Resolved");
  const drawer = toggle.parentElement!;
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
  // Held over Resolved, it lights as the place the thread will land.
  const dataTransfer = dragData();
  fireEvent.dragStart(screen.getByRole("button", { name: /Recent notes/ }), { dataTransfer });
  fireEvent.dragOver(drawer, { dataTransfer });
  expect(drawer.hasAttribute("data-drop")).toBe(true);
  fireEvent.dragLeave(drawer, { dataTransfer, relatedTarget: document.body });
  fireEvent.dragEnd(screen.getByRole("button", { name: /Recent notes/ }), { dataTransfer });
  expect(drawer.hasAttribute("data-drop")).toBe(false);
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
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(["running", "recent"]));
  fireEvent.click(screen.getByRole("button", { name: "Snoozed 1" }));
  expect(useUi.getState().threadOrder).toEqual(["running", "recent", "snoozed"]);
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
