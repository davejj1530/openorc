import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { Task, TaskStatus } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TaskListView } from "./TaskList";
import { statusLabel } from "../components/status";
import { core } from "../lib/rpc";
import { queryClient } from "../lib/query";
import { useRouter } from "../lib/router";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onInvalidate: vi.fn(), onReady: vi.fn() } }));
vi.mock("../components/TopBar", () => ({ TopBar: () => null }));
const task: Task = {
  id: "task",
  projectId: "project",
  title: "Export rows",
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
let saved: Task[];
let update: (status: TaskStatus) => Promise<void>;
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
  useRouter.setState({ route: { view: "tasks" }, threadIds: [] });
  saved = [{ ...task }, { ...task, id: "other", title: "Review copy", status: "review" }];
  update = async () => {};
  vi.mocked(core.call).mockImplementation(async (method, params) => {
    if (method === "projects.list") return [];
    if (method === "tasks.list") return saved;
    if (method === "tasks.update" && "id" in params && "patch" in params && "status" in params.patch && params.patch.status) {
      const status = params.patch.status;
      await update(status);
      saved = saved.map((item) => (item.id === params.id ? { ...item, status } : item));
      return saved[0]!;
    }
    throw new Error(`Unexpected RPC: ${method}`);
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
async function show() {
  render(
    <QueryClientProvider client={queryClient}>
      <TaskListView onNewTask={() => {}} />
    </QueryClientProvider>,
  );
  return screen.findByRole("button", { name: "Status for Export rows" });
}
async function moveStatus(status: TaskStatus) {
  fireEvent.click(await screen.findByRole("button", { name: "Status for Export rows" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: statusLabel[status] }));
}
it("moves rows and updates group counts without opening or starting a task", async () => {
  const trigger = await show();
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "j" });
  expect(useRouter.getState().route).toEqual({ view: "tasks" });
  fireEvent.click(trigger);
  expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent?.trim())).toEqual(["Proposed", "Backlog", "In progress", "Review", "Done", "Archived"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Review" }));
  await waitFor(() => expect(document.querySelector('[data-status-group="backlog"]')).toBeNull());
  expect(within(screen.getByRole("region", { name: /Review/ })).getByLabelText("2 tasks")).toBeTruthy();
  expect(core.call).toHaveBeenCalledWith("tasks.update", { id: "task", patch: { status: "review" } });
  expect(useRouter.getState().route).toEqual({ view: "tasks" });
  expect(document.activeElement).toBe(document.querySelector(".task-list"));
  fireEvent.click(screen.getByRole("button", { name: "Export rows, Review" }));
  expect(useRouter.getState().route).toEqual({ view: "task", taskId: "task", tab: "spec" });
});
it("moves between Active, Done, and Archived shelves and can restore a task", async () => {
  await show();
  await moveStatus("done");
  await waitFor(() => expect(screen.queryByRole("button", { name: "Status for Export rows" })).toBeNull());
  fireEvent.click(screen.getByRole("radio", { name: "Done" }));
  await moveStatus("archived");
  await waitFor(() => expect(screen.queryByRole("button", { name: "Status for Export rows" })).toBeNull());
  fireEvent.click(screen.getByRole("radio", { name: "Archived" }));
  await moveStatus("backlog");
  await waitFor(() => expect(screen.queryByRole("button", { name: "Status for Export rows" })).toBeNull());
  fireEvent.click(screen.getByRole("radio", { name: "Active" }));
  await screen.findByRole("button", { name: "Export rows, Backlog" });
});
it("disables only the saving row, retains its status on failure and lets the user retry", async () => {
  let reject!: (error: Error) => void;
  update = () =>
    new Promise((_resolve, fail) => {
      reject = fail;
    });
  const trigger = await show();
  await moveStatus("in_progress");
  await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(true));
  expect(screen.getByRole("status").textContent).toBe("Saving…");
  expect(screen.getByRole("button", { name: "Status for Review copy" }).hasAttribute("disabled")).toBe(false);
  reject(new Error("Connection lost"));
  expect((await screen.findByRole("alert")).textContent).toContain("Connection lost");
  expect(trigger.getAttribute("title")).toBe("Change status · Backlog");
  expect(trigger.hasAttribute("disabled")).toBe(false);
  update = async () => {};
  await moveStatus("in_progress");
  await screen.findByRole("button", { name: "Export rows, In progress" });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(useRouter.getState().route).toEqual({ view: "tasks" });
});

it("filters by stage and clears that filter when changing shelves", async () => {
  await show();
  const stages = screen.getByLabelText("Task status");
  fireEvent.click(within(stages).getByRole("button", { name: /Review/ }));
  expect(screen.queryByRole("button", { name: "Export rows, Backlog" })).toBeNull();
  expect(screen.getByRole("button", { name: "Review copy, Review" })).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "Done" }));
  fireEvent.click(screen.getByRole("radio", { name: "Active" }));
  expect(screen.getByRole("button", { name: "Export rows, Backlog" })).toBeTruthy();
  expect(
    within(stages)
      .getByRole("button", { name: /Review/ })
      .getAttribute("aria-pressed"),
  ).toBe("false");
});
