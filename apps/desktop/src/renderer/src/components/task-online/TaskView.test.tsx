import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OnlineTaskView } from "./TaskView";
import { TaskListView } from "../../views/TaskList";
import { core } from "../../lib/rpc";
import { queryClient } from "../../lib/client";
import { onlineReference, onlineTask } from "../../lib/test-fixtures/online-task";

const navigation = vi.hoisted(() => ({
  current: "org:studio",
  key: "account-a",
  ownership: "everyone",
  inventory: [{ id: "org:studio", accountId: "account-a", personal: false, projects: [], threads: [], taskIds: [] }],
}));
vi.mock("../../lib/space-navigation", () => ({ useSpaceNavigation: <T,>(select: (state: typeof navigation) => T) => select(navigation), spaceNavigation: { getState: () => navigation } }));
vi.mock("../../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
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
const completed = onlineTask({ id: "task-completed", title: "Finished server work", status: "done" });
beforeEach(() => {
  localStorage.clear();
  navigation.current = "org:studio";
  task = onlineTask({
    assignee: { userId: "account-a", memberId: "member-a", name: "Alex", image: null, available: true },
    assignmentRevision: 3,
    viewer: { ...onlineTask().viewer, unseenAssignment: true, attention: ["assignment"] },
  });
  getFails = false;
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
