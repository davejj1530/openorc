import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { defaultOrclingLook, WORKSPACE_ID, type RpcParams, type ThreadSummary } from "@openorc/protocol";

vi.hoisted(() => Object.assign(window, { openorc: { platform: "darwin" } }));

const fixture: {
  projects: { id: string; name: string; rootPath: string }[];
  threads: (Pick<ThreadSummary, "id" | "title" | "projectId" | "agent" | "activity" | "unread" | "session" | "pinnedAt" | "snoozedUntil" | "lastActivityAt"> &
    Partial<Pick<ThreadSummary, "createdAt" | "archivedAt">>)[];
} = vi.hoisted(() => ({ projects: [], threads: [] }));

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
    return undefined;
  };
  return { ...(await original<object>()), useRpc: (method: string, params: { id?: string }) => ({ data: rpcData(method, params) }), usePendingApprovals: () => 0, useRun: () => undefined };
});
vi.mock("../lib/rpc", () => ({
  core: {
    call: vi.fn(async (method: string, params: RpcParams<"threads.list">) => {
      if (method !== "threads.list") return [];
      const rows = fixture.threads.filter(
        (thread) =>
          (!params.projectId || thread.projectId === params.projectId) &&
          (!params.projectIds || params.projectIds.includes(thread.projectId)) &&
          (!params.pinnedOnly || thread.pinnedAt) &&
          (params.filter === "archived") === Boolean(thread.archivedAt),
      );
      if (params.orderBy === "activity") rows.sort((a, b) => b.lastActivityAt - a.lastActivityAt || b.id.localeCompare(a.id));
      return rows.slice(0, params.limit);
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

afterEach(cleanup);
beforeEach(() => {
  fixture.projects = [];
  fixture.threads = [];
  localStorage.clear();
  useWindow.setState({ fullscreen: false });
  useLayout.setState({ collapsed: [], projectId: null, sidebarOpen: true, sidebarFilter: "active", pinnedOnly: false, ungroupByProjects: false });
  useRouter.setState({ route: { view: "newthread" }, history: [], future: [], threadIds: [] });
});

const mountSidebar = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Sidebar />
    </QueryClientProvider>,
  );

const folded = `project:${WORKSPACE_ID}`;
const open = (threadId: string) => {
  useLayout.setState({ collapsed: [folded], sidebarOpen: true });
  useRouter.setState({ route: { view: "thread", threadId } });
  mountSidebar();
};

it("shows the OpenOrc wordmark only while fullscreen and keeps the header controls available", () => {
  mountSidebar();
  expect(screen.queryByRole("img", { name: "OpenOrc" })).toBeNull();
  act(() => useWindow.setState({ fullscreen: true }));
  expect(screen.getByRole("img", { name: "OpenOrc" }).textContent).toBe("OpenOrc");
  expect(
    within(screen.getByRole("group", { name: "Window" }))
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label")),
  ).toEqual(["Inbox", "Search", "Toggle sidebar"]);
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Forward" })).toBeNull();
  act(() => useWindow.setState({ fullscreen: false }));
  expect(screen.queryByRole("img", { name: "OpenOrc" })).toBeNull();
});

it("unfolds the project that lists the opened thread", () => {
  open("notes");
  expect(useLayout.getState().collapsed).not.toContain(folded);
});

it("leaves Workspace folded when an Orcling's own conversation opens, since Orclings list it", () => {
  open("rini-home");
  expect(useLayout.getState().collapsed).toContain(folded);
});

it("switches between project threads and Orclings in one sidebar, remembering the project thread", () => {
  open("notes");
  expect(screen.getByRole("region", { name: "Thread browser" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Orclings" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Orclings" }));
  expect(useRouter.getState().route).toEqual({ view: "thread", threadId: "rini-home" });
  expect(screen.queryByRole("region", { name: "Thread browser" })).toBeNull();
  expect(screen.getByRole("region", { name: "Orclings" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Threads" }).getAttribute("aria-current")).toBeNull();
  expect(screen.getByRole("button", { name: "Orclings" }).getAttribute("aria-current")).toBe("page");
  fireEvent.click(screen.getByRole("button", { name: "Threads" }));
  expect(useRouter.getState().route).toEqual({ view: "thread", threadId: "notes" });
  expect(screen.getByRole("region", { name: "Thread browser" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Orclings" })).toBeNull();
});

it("opens project conversations when Threads is chosen from an initial Orcling chat", () => {
  open("rini-home");
  fireEvent.click(screen.getByRole("button", { name: "Threads" }));
  expect(useRouter.getState().route).toMatchObject({ view: "newthread" });
  expect(screen.queryByRole("region", { name: "Orclings" })).toBeNull();
});

it.each([false, true])("keeps the current conversation destination when the selected Threads tab is clicked (draft=%s)", (draft) => {
  open("notes");
  if (draft) fireEvent.click(screen.getByRole("button", { name: "New thread" }));
  const { route, history } = useRouter.getState();
  fireEvent.click(screen.getByRole("button", { name: "Threads" }));
  expect(useRouter.getState().route).toEqual(route);
  expect(useRouter.getState().history).toEqual(history);
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

it("narrows to orcmode's working set, hides projects with nothing in it, and keeps search and the rest one step away", async () => {
  const day = 86_400_000;
  fixture.projects = [
    { id: "one", name: "First project", rootPath: "/projects/one" },
    { id: "quiet", name: "Quiet project", rootPath: "/projects/quiet" },
  ];
  fixture.threads = [
    { id: "today", title: "Today's work", projectId: "one", lastActivityAt: Date.now() - 60_000 },
    { id: "old", title: "Old notes", projectId: "one", lastActivityAt: Date.now() - 3 * day },
    { id: "dusty", title: "Dusty idea", projectId: "quiet", lastActivityAt: Date.now() - 9 * day },
  ].map((thread) => ({ ...thread, agent: "codex", activity: "idle", unread: false, session: { status: "idle", message: null }, pinnedAt: null, snoozedUntil: null }));
  mountSidebar();
  await screen.findByRole("button", { name: /Old notes/ });
  fireEvent.click(screen.getByRole("button", { name: "Filter threads" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Orcmode" }));
  expect(screen.getByRole("button", { name: /Today's work/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Old notes|Dusty idea/ })).toBeNull();
  expect(screen.queryByText("Quiet project")).toBeNull();
  expect(screen.getByRole("button", { name: "Filter threads: Orcmode" })).toBeTruthy();
  expect(useUi.getState().threadOrder).toEqual(["today"]);
  // A search reaches every thread, and the end of the list leads back to all of them.
  fireEvent.change(screen.getByRole("textbox", { name: "Filter loaded threads" }), { target: { value: "dusty" } });
  expect(screen.getByRole("button", { name: /Dusty idea/ })).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "Filter loaded threads" }), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Show 2 more" }));
  expect(screen.getByRole("button", { name: /Old notes/ })).toBeTruthy();
  expect(useLayout.getState().sidebarFilter).toBe("active");
});

it("says so when nothing needs you, with every thread still one click away", async () => {
  projectThreads();
  fixture.threads = fixture.threads.map((thread) => ({ ...thread, pinnedAt: null, lastActivityAt: Date.now() - 2 * 86_400_000 }));
  useLayout.setState({ sidebarFilter: "orc" });
  mountSidebar();
  expect(await screen.findByText("Nothing needs you today.")).toBeTruthy();
  expect(screen.queryByText("First project")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show 4 more" }));
  expect(await screen.findByRole("button", { name: /Regular notes/ })).toBeTruthy();
});

it("toggles orcmode from the keyboard, leaving pinned-only behind and remembering the choice", () => {
  useLayout.setState({ sidebarFilter: "active", pinnedOnly: true });
  useLayout.getState().toggleOrcMode();
  expect(useLayout.getState()).toMatchObject({ sidebarFilter: "orc", pinnedOnly: false });
  expect(JSON.parse(localStorage.getItem("openorc.layout") ?? "{}")).toMatchObject({ sidebarFilter: "orc" });
  useLayout.getState().toggleOrcMode();
  expect(useLayout.getState().sidebarFilter).toBe("active");
});

it("collapses a whole project and removes its pinned, ordinary, and open snoozed rows from keyboard order", async () => {
  projectThreads();
  useLayout.setState({ collapsed: ["snoozed-open:one"] });
  mountSidebar();
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(["pinned", "regular", "snoozed", "other"]));
  fireEvent.click(screen.getByRole("button", { name: "Collapse First project threads" }));
  const toggle = screen.getByRole("button", { name: "Expand First project threads" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(document.getElementById(toggle.getAttribute("aria-controls")!)?.hidden).toBe(true);
  expect(screen.queryByRole("button", { name: /Pinned notes|Regular notes|Snoozed notes/ })).toBeNull();
  expect(await screen.findByRole("button", { name: /Other notes/ })).toBeTruthy();
  expect(useUi.getState().threadOrder).toEqual(["other"]);
  expect(JSON.parse(localStorage.getItem("openorc.layout")!).collapsed).toContain("project:one");
  fireEvent.click(toggle);
  expect(screen.getByRole("button", { name: "Collapse First project threads" }).getAttribute("aria-expanded")).toBe("true");
  expect(useUi.getState().threadOrder).toEqual(["pinned", "regular", "snoozed", "other"]);
});

it("retains saved project folds across remounts and scope changes without hiding other projects", async () => {
  projectThreads();
  const view = mountSidebar();
  await screen.findByRole("button", { name: /Regular notes/ });
  fireEvent.click(screen.getByRole("button", { name: "Collapse First project threads" }));
  view.unmount();
  mountSidebar();
  expect(screen.getByRole("button", { name: "Expand First project threads" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Regular notes/ })).toBeNull();
  act(() => useLayout.getState().setProject("one"));
  expect(screen.queryByRole("button", { name: /Regular notes/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Expand First project threads" })).toBeTruthy();
  expect(await screen.findByRole("button", { name: /Other notes/ })).toBeTruthy();
  expect(useLayout.getState().collapsed).toContain("project:one");
  expect(useUi.getState().threadOrder).toEqual(["other"]);
  act(() => useLayout.getState().setProject(null));
  expect(screen.getByRole("button", { name: "Expand First project threads" })).toBeTruthy();
  expect(useUi.getState().threadOrder).toEqual(["other"]);
});

it("keeps a project folded while searching and changing pinned filters", async () => {
  projectThreads();
  mountSidebar();
  await screen.findByRole("button", { name: /Regular notes/ });
  fireEvent.click(screen.getByRole("button", { name: "Collapse First project threads" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Filter loaded threads" }), { target: { value: "notes" } });
  fireEvent.click(screen.getByRole("button", { name: "Filter threads" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Pinned threads" }));
  expect(screen.getByRole("button", { name: "Expand First project threads" })).toBeTruthy();
  expect(useUi.getState().threadOrder).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Expand First project threads" }));
  expect(screen.getByRole("button", { name: /Pinned notes/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Regular notes/ })).toBeNull();
  expect(useUi.getState().threadOrder).toEqual(["pinned"]);
});

it("reveals a folded project when a thread there is opened through navigation", async () => {
  projectThreads();
  useLayout.setState({ collapsed: ["project:one"] });
  mountSidebar();
  await screen.findByRole("button", { name: "Expand First project threads" });
  act(() => useRouter.getState().navigate({ view: "thread", threadId: "regular" }));
  expect(screen.getByRole("button", { name: "Collapse First project threads" })).toBeTruthy();
  expect(screen.getByRole("button", { name: /Regular notes/ }).getAttribute("aria-current")).toBe("page");
  expect(useLayout.getState().projectId).toBeNull();
});

it("creates a new thread in the requested project while every project stays available", async () => {
  projectThreads();
  mountSidebar();
  await screen.findByRole("button", { name: /Regular notes/ });
  fireEvent.click(screen.getByRole("button", { name: "New thread in Second project" }));
  expect(useRouter.getState().route).toEqual({ view: "newthread", projectId: "two" });
  expect(useLayout.getState().projectId).toBe("two");
  expect(screen.getByRole("button", { name: /Regular notes/ })).toBeTruthy();
  expect(await screen.findByRole("button", { name: /Other notes/ })).toBeTruthy();
});

it("keeps activity visible in folded projects and keeps project navigation on task screens", async () => {
  projectThreads();
  fixture.threads[1]!.activity = "running";
  useRouter.setState({ route: { view: "tasks" } });
  mountSidebar();
  await screen.findByRole("button", { name: /Regular notes/ });
  fireEvent.click(screen.getByRole("button", { name: "Collapse First project threads" }));
  expect(within(screen.getByRole("region", { name: "First project threads" })).getByText("1 running")).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "Second project threads" })).getByText("1 thread")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Regular notes/ })).toBeNull();
  expect(screen.getByRole("button", { name: "New thread in First project" })).toBeTruthy();
});

it("says a folded project needs you before anything else", async () => {
  projectThreads();
  fixture.threads[1]!.activity = "running";
  fixture.threads[0]!.activity = "waiting";
  useLayout.setState({ collapsed: ["project:one"] });
  mountSidebar();
  const region = await screen.findByRole("region", { name: "First project threads" });
  await waitFor(() => expect(region.querySelector(".project-group-activity")?.textContent).toBe("Needs you"));
});

async function toggleProjectGrouping() {
  fireEvent.click(screen.getByRole("button", { name: /^Filter threads/ }));
  const toggle = await screen.findByRole("menuitemcheckbox", { name: "Ungroup by projects" });
  fireEvent.click(toggle);
  fireEvent.keyDown(toggle, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
}

it("toggles to one recently-active list, remembers the choice, and restores saved project folds", async () => {
  projectThreads();
  fixture.threads = fixture.threads.map((thread, index) => ({ ...thread, createdAt: index + 1, lastActivityAt: 100 - index }));
  useLayout.setState({ collapsed: ["project:one"] });
  mountSidebar();
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(["other"]));
  await toggleProjectGrouping();
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(["pinned", "regular", "other"]));
  expect(document.querySelectorAll(".sidebar-project")).toHaveLength(0);
  expect(screen.queryByText("First project")).toBeNull();
  expect(screen.queryByText("Second project")).toBeNull();
  expect(useLayout.getState().collapsed).toEqual(["project:one"]);
  expect(JSON.parse(localStorage.getItem("openorc.layout") ?? "{}").ungroupByProjects).toBe(true);
  await toggleProjectGrouping();
  await screen.findByRole("button", { name: "Expand First project threads" });
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(["other"]));
  expect(useLayout.getState().ungroupByProjects).toBe(false);
});

it("pages one activity-ordered list across projects without promoting pins or newer creation dates", async () => {
  projectThreads();
  const base = fixture.threads[0]!;
  fixture.threads = Array.from({ length: 28 }, (_, index) => ({
    ...base,
    id: `row-${index}`,
    title: `Thread ${index}`,
    projectId: index % 2 ? "one" : "two",
    createdAt: index + 1,
    lastActivityAt: 100 - index,
    pinnedAt: index === 27 ? 1 : null,
  }));
  useLayout.setState({ ungroupByProjects: true });
  mountSidebar();
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(Array.from({ length: 12 }, (_, index) => `row-${index}`)));
  fireEvent.click(screen.getByRole("button", { name: "Load more threads" }));
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(Array.from({ length: 24 }, (_, index) => `row-${index}`)));
  fireEvent.click(screen.getByRole("button", { name: "Load more threads" }));
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(Array.from({ length: 28 }, (_, index) => `row-${index}`)));
  expect(screen.queryByRole("button", { name: "Load more threads" })).toBeNull();
});

it("keeps pinned, archived and title filters available while projects are ungrouped", async () => {
  projectThreads();
  const base = fixture.threads[0]!;
  fixture.threads = [
    ...Array.from({ length: 14 }, (_, index) => ({ ...base, id: `new-${index}`, title: `New ${index}`, createdAt: index + 2, lastActivityAt: index + 2, pinnedAt: null })),
    { ...base, createdAt: 1, lastActivityAt: 1 },
    { ...base, id: "archived", title: "Archived notes", archivedAt: 20, createdAt: 16, pinnedAt: null },
    { ...base, id: "home", title: "Removed project notes", projectId: "removed", createdAt: 100 },
    { ...base, id: "rini-home", title: "Private companion", projectId: WORKSPACE_ID, createdAt: 101 },
  ];
  useLayout.setState({ ungroupByProjects: true });
  mountSidebar();
  await screen.findByRole("button", { name: /New 13/ });
  expect(screen.queryByRole("button", { name: /Removed project notes|Private companion/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^Filter threads/ }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Pinned threads" }));
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(["pinned"]));
  fireEvent.click(screen.getByRole("button", { name: /^Filter threads/ }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Archived threads" }));
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(["archived"]));
  fireEvent.change(screen.getByRole("textbox", { name: "Filter loaded threads" }), { target: { value: "no match" } });
  expect(screen.getByText("No matches in loaded threads.")).toBeTruthy();
  expect(useUi.getState().threadOrder).toEqual([]);
  expect(useLayout.getState().ungroupByProjects).toBe(true);
});

it("keeps orcmode's working set and a shared snoozed section in the flat list", async () => {
  projectThreads();
  const base = fixture.threads[0]!;
  fixture.threads = [
    { ...base, id: "running", title: "Older running thread", createdAt: 1, lastActivityAt: Date.now() - 1000, pinnedAt: null, activity: "running" },
    { ...base, id: "recent", title: "Newer recent thread", projectId: "two", createdAt: 3, pinnedAt: null },
    { ...base, id: "quiet", title: "Older quiet thread", createdAt: 2, pinnedAt: null, lastActivityAt: Date.now() - 3 * 86_400_000 },
    { ...base, id: "snoozed", title: "Snoozed thread", createdAt: 4, pinnedAt: null, snoozedUntil: Date.now() + 60_000 },
  ];
  useLayout.setState({ ungroupByProjects: true });
  mountSidebar();
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(["recent", "running", "quiet"]));
  fireEvent.click(screen.getByRole("button", { name: "Snoozed 1" }));
  expect(useUi.getState().threadOrder).toEqual(["recent", "running", "quiet", "snoozed"]);
  fireEvent.click(screen.getByRole("button", { name: /^Filter threads/ }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Orcmode" }));
  await waitFor(() => expect(useUi.getState().threadOrder).toEqual(["recent", "running"]));
  expect(screen.queryByRole("button", { name: /Older quiet thread|Snoozed thread/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Show 2 more" })).toBeTruthy();
  expect(useLayout.getState().ungroupByProjects).toBe(true);
});

it("retains orcmode work from every project even when another project fills a page", async () => {
  projectThreads();
  const base = fixture.threads[0]!;
  fixture.threads = [
    ...Array.from({ length: 14 }, (_, index) => ({ ...base, id: `new-${index}`, title: `New ${index}`, createdAt: index + 2, pinnedAt: null })),
    { ...base, id: "working", title: "Older work in another project", projectId: "two", createdAt: 1, pinnedAt: null, activity: "running" },
  ];
  useLayout.setState({ ungroupByProjects: true, sidebarFilter: "orc" });
  mountSidebar();
  expect(await screen.findByRole("button", { name: /Older work in another project/ })).toBeTruthy();
  await waitFor(() => expect(useUi.getState().threadOrder).toContain("working"));
  expect(document.querySelectorAll(".sidebar-project")).toHaveLength(0);
});
