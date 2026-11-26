import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OnlineTaskView } from "./TaskView";
import { TaskListView } from "../../views/TaskList";
import { core } from "../../lib/rpc";
import { queryClient } from "../../lib/client";
import { onlineReference, onlineTask } from "../../lib/test-fixtures/online-task";
import { clearOnlineTaskListState } from "../../lib/task-list-state";
import { taskAccess } from "../../lib/test-fixtures/task-access";
import { organizationContentGate } from "../../lib/organization-content-gate";

const navigation = vi.hoisted(() => ({
  current: "org:studio",
  key: "account-a",
  ownership: "everyone",
  inventory: [{ id: "org:studio", accountId: "account-a", personal: false, projects: [], threads: [], taskIds: [] }],
}));
vi.mock("../../lib/space-navigation", () => ({ useSpaceNavigation: <T,>(select: (state: typeof navigation) => T) => select(navigation), spaceNavigation: { getState: () => navigation } }));
vi.mock("../../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
// The Tasks page beside the task holds the board's pane, whose head reads the window's controls.
vi.mock("../../lib/window", () => ({ useTrafficLights: () => false, useWindowsControls: () => false }));
vi.mock("../TopBar", () => ({
  TopBar: ({ children, actions }: { children?: ReactNode; actions?: ReactNode }) => (
    <header>
      {children}
      {actions}
    </header>
  ),
}));
vi.mock("../ScopedTitle", () => ({ ScopedTitle: ({ children }: { children: ReactNode }) => children }));
vi.mock("../DocumentEditor", () => ({ DocumentEditor: () => <div /> }));
let task = onlineTask();
let getFails = false;
let access = taskAccess();
const completed = onlineTask({ id: "task-completed", title: "Finished server work", status: "done" });
beforeEach(() => {
  localStorage.clear();
  clearOnlineTaskListState(["org:studio"]);
  navigation.current = "org:studio";
  task = onlineTask({
    assignee: { userId: "account-a", memberId: "member-a", name: "Alex", image: null, available: true },
    assignmentRevision: 3,
    viewer: { ...onlineTask().viewer, unseenAssignment: true, attention: ["assignment"] },
  });
  getFails = false;
  access = taskAccess();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.mocked(core.call).mockImplementation(async (method, params) => {
    if (method === "spaces.refresh") return { ...access, heardAt: Date.now() };
    if (method === "tasks.online.state") return { state: "ready", ...onlineReference, execution: false, personal: false };
    if (method === "tasks.online.list") return { accessRevision: 1, tasks: "status" in params && params.status === "done" ? [completed] : [task], cursor: null };
    if (method === "tasks.online.get") {
      if (getFails) throw new Error("Not found");
      return { accessRevision: 1, task };
    }
    if (method === "tasks.online.seen") {
      task = { ...task, viewer: { ...task.viewer, unseenAssignment: false, attention: [] } };
      return { accessRevision: 1, task };
    }
    if (method === "tasks.online.attention") return { accessRevision: 1, count: task.viewer.attention.length };
    if (method === "tasks.online.context") return { accessRevision: 1, task, context: null };
    if (method === "spaces.projects" || method === "projects.list" || method === "tasks.list") return [];
    throw new Error(`Unexpected RPC: ${method}`);
  });
});
afterEach(() => {
  cleanup();
  organizationContentGate.reset();
  queryClient.clear();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
const wrap = (children: ReactNode) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;

it("does not mark a listed assignment seen, then acknowledges its exact generation in Overview", async () => {
  const list = render(wrap(<TaskListView onNewTask={() => {}} />));
  await screen.findByText(task.title);
  expect(vi.mocked(core.call).mock.calls.some(([method]) => method === "tasks.online.seen")).toBe(false);
  list.unmount();
  render(wrap(<OnlineTaskView reference={onlineReference} tab="spec" />));
  await screen.findByRole("textbox", { name: "Task title" });
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("tasks.online.seen", expect.objectContaining({ spaceId: onlineReference.spaceId, id: onlineReference.id, assignmentRevision: 3 })));
  expect(vi.mocked(core.call).mock.calls.some(([method]) => method === "tasks.get" || method === "tasks.update" || method === "tasks.openThread")).toBe(false);
});
it("marks an assignee who can't use the project with a lock, and keeps them assigned", async () => {
  task = { ...task, assignee: { ...task.assignee!, available: false } };
  render(wrap(<OnlineTaskView reference={onlineReference} tab="spec" />));
  expect(await screen.findByRole("button", { name: "Assignee: Alex. This person can’t use the project right now." })).toBeTruthy();
});
it("never reads a Mac task when an online task is refused", async () => {
  getFails = true;
  render(wrap(<OnlineTaskView reference={onlineReference} tab="spec" />));
  await screen.findByText("This task isn’t available here.");
  expect(screen.queryByRole("textbox", { name: "Task title" })).toBeNull();
  expect(vi.mocked(core.call).mock.calls.some(([method]) => method === "tasks.get")).toBe(false);
});
it("drops a cached document immediately when its account no longer owns the space", async () => {
  const view = render(wrap(<OnlineTaskView reference={onlineReference} tab="spec" />));
  await screen.findByRole("textbox", { name: "Task title" });
  navigation.current = "missing-space";
  view.rerender(wrap(<OnlineTaskView reference={onlineReference} tab="spec" />));
  expect(screen.queryByRole("textbox", { name: "Task title" })).toBeNull();
  expect(screen.queryByText(task.title)).toBeNull();
});

it("reads the server's Done shelf instead of filtering an active-only page", async () => {
  render(wrap(<TaskListView onNewTask={() => {}} />));
  await screen.findByText(task.title);
  fireEvent.click(screen.getByRole("button", { name: "Filter tasks" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "Done" }));
  await screen.findByText(completed.title);
  expect(core.call).toHaveBeenCalledWith("tasks.online.list", expect.objectContaining({ status: "done", spaceId: onlineReference.spaceId }));
});

it("shows the selected shelf immediately while the previous list is held under the pointer", async () => {
  render(wrap(<TaskListView onNewTask={() => {}} />));
  await screen.findByText(task.title);
  fireEvent.click(screen.getByRole("button", { name: "Filter tasks" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "Done" }));
  const done = await screen.findByText(completed.title);
  fireEvent.pointerEnter(done.closest(".task-list")!);
  fireEvent.click(screen.getByRole("button", { name: /Filter tasks/ }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "Active" }));
  expect(screen.getByText(task.title)).toBeTruthy();
});

it("replaces an open protected document with the shared frozen screen while retaining the person's words", async () => {
  render(wrap(<OnlineTaskView reference={onlineReference} tab="spec" />));
  fireEvent.change(await screen.findByRole("textbox", { name: "Task title" }), { target: { value: "My unsaved words" } });
  access = { ...access, organizationAccess: { state: "frozen", reason: "seat_removed", until: null, message: "Your day of grace has ended." } };
  await act(async () => {
    await organizationContentGate.refresh();
  });
  await screen.findByText("Your day of grace has ended.");
  expect(screen.queryByRole("textbox", { name: "Task title" })).toBeNull();
  expect(screen.queryByText(task.title)).toBeNull();
  expect(Object.values(localStorage).join(" ")).toContain("My unsaved words");
  expect(
    queryClient
      .getQueryCache()
      .findAll({ queryKey: ["online-tasks"] })
      .filter((query) => query.state.data !== undefined),
  ).toHaveLength(0);
  expect(vi.mocked(core.call).mock.calls.some(([method]) => method === "tasks.update" || method === "tasks.online.update")).toBe(false);
});

it("lists the person's own Personal cloud tasks beside this Mac's, with no assignment, and opens one with no assignee", async () => {
  navigation.inventory = [...navigation.inventory, { id: "personal-a", accountId: "account-a", personal: true, projects: [], threads: [], taskIds: [] }];
  navigation.current = "personal-a";
  // As the server lists them: one Personal space, beside the organizations.
  access = { ...access, spaces: [...access.spaces, { id: "personal-a", kind: "personal" }] };
  const personal = { ...onlineReference, spaceId: "personal-a", id: "task-personal" };
  const mine = onlineTask({ id: personal.id, spaceId: personal.spaceId, title: "Draft the launch post" });
  const local = {
    id: "local-task",
    projectId: "project-a",
    title: "Tidy the README",
    spec: null,
    status: "backlog",
    priority: "none",
    labels: [],
    workspaceMode: "current",
    baseRef: null,
    baseSha: null,
    branch: null,
    worktreePath: null,
    parentTaskId: null,
    threadId: null,
    executionThreadId: null,
    origin: "user",
    reviewedSnapshotId: null,
    costUsd: 0,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
  };
  vi.mocked(core.call).mockImplementation(async (method) => {
    if (method === "spaces.refresh") return { ...access, heardAt: Date.now() };
    if (method === "tasks.online.state") return { state: "ready", accountId: "account-a", spaceId: "personal-a", execution: false, personal: true };
    if (method === "tasks.online.list") return { accessRevision: 1, tasks: [mine], cursor: null };
    if (method === "tasks.online.get" || method === "tasks.online.seen") return { accessRevision: 1, task: mine };
    if (method === "tasks.online.attention") return { accessRevision: 1, count: 0 };
    if (method === "tasks.online.context") return { accessRevision: 1, task: mine, context: null };
    if (method === "tasks.list") return [local];
    if (method === "spaces.projects" || method === "projects.list") return [];
    throw new Error(`Unexpected RPC: ${method}`);
  });
  const list = render(wrap(<TaskListView onNewTask={() => {}} />));
  expect(await screen.findByText("Draft the launch post")).toBeTruthy();
  expect(screen.getByText("Tidy the README")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Filter tasks/ }));
  await screen.findAllByRole("menuitemradio");
  expect(screen.queryByText("Assigned to me")).toBeNull();
  list.unmount();
  render(wrap(<OnlineTaskView reference={personal} tab="spec" />));
  await screen.findByRole("textbox", { name: "Task title" });
  expect(screen.queryByRole("button", { name: /^Assignee/ })).toBeNull();
});
