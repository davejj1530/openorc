import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { defaultOrclingLook, WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";

const fixture: {
  projects: { id: string; name: string; rootPath: string }[];
  threads: Pick<ThreadSummary, "id" | "title" | "projectId" | "agent" | "activity" | "unread" | "session" | "pinnedAt" | "snoozedUntil" | "lastActivityAt">[];
} = vi.hoisted(() => ({ projects: [], threads: [] }));

vi.mock("../lib/query", () => {
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
  return { useRpc: (method: string, params: { id?: string }) => ({ data: rpcData(method, params) }), tagsFor: () => [] };
});
vi.mock("../lib/rpc", () => ({
  core: {
    call: vi.fn(async (method: string, params: { projectId?: string; limit?: number }) =>
      method === "threads.list" ? fixture.threads.filter((thread) => thread.projectId === params.projectId).slice(0, params.limit) : [],
    ),
  },
}));
vi.mock("../lib/transcript", () => ({ usePendingApprovals: () => 0 }));
vi.mock("../lib/window", () => ({ useTrafficLights: () => false, useWindowsControls: () => false }));
vi.mock("../lib/browser-preview", () => ({ CoversPreview: () => null }));
vi.mock("./ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ui")>()),
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));

import { useLayout } from "../lib/layout";
import { useRouter } from "../lib/router";
import { useUi } from "../lib/ui";
import { Sidebar } from "./Sidebar";

afterEach(cleanup);
beforeEach(() => {
  fixture.projects = [];
  fixture.threads = [];
  localStorage.clear();
  useLayout.setState({ collapsed: [], projectId: null, sidebarOpen: true, sidebarFilter: "active" });
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

it.each([
  ["Inbox", "inbox"],
  ["Back", "tasks"],
  ["Forward", "settings"],
])("dismisses compact navigation after choosing %s in the footer", (label, destination) => {
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
  expect(within(screen.getByRole("region", { name: "First project threads" })).getByText("Running")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Regular notes/ })).toBeNull();
  expect(screen.getByRole("button", { name: "New thread in First project" })).toBeTruthy();
});
