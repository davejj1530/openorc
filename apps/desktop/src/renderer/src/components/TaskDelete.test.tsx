import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Task } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { TaskDelete } from "./TaskDelete";
import { core } from "../lib/rpc";
import { useRouter } from "../lib/router";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onInvalidate: vi.fn(), onReady: vi.fn() } }));
const task: Task = {
  id: "task",
  projectId: "project",
  title: "Export rows",
  spec: "Save CSV",
  status: "in_progress",
  priority: "none",
  labels: [],
  workspaceMode: "worktree",
  baseRef: null,
  baseSha: null,
  branch: null,
  worktreePath: null,
  parentTaskId: null,
  threadId: "creator",
  executionThreadId: "execution",
  origin: "user",
  reviewedSnapshotId: null,
  costUsd: 0,
  createdAt: 1,
  updatedAt: 1,
  completedAt: null,
};
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function show() {
  useRouter.setState({ route: { view: "task", taskId: task.id, tab: "spec" }, threadIds: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TaskDelete task={task} />
    </QueryClientProvider>,
  );
}

it("deletes an ordinary task only after confirmation, then returns to the task list", async () => {
  vi.mocked(core.call).mockResolvedValue(null);
  show();
  fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
  expect(core.call).not.toHaveBeenCalled();
  expect(screen.getByText(/Its conversation keeps its messages and changes/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("tasks.delete", { id: "task" }));
  await waitFor(() => expect(useRouter.getState().route.view).toBe("tasks"));
});

it("keeps the task open and shows why when deleting fails", async () => {
  vi.mocked(core.call).mockRejectedValueOnce(new Error("The task is busy"));
  show();
  fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await screen.findByText("The task is busy");
  expect(useRouter.getState().route.view).toBe("task");
});
