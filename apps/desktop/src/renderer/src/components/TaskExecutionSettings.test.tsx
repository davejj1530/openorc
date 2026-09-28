import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Task } from "@openorc/protocol";
import { TaskExecutionSettings, useTaskExecutionLocation } from "./TaskExecutionSettings";

const mocks = vi.hoisted(() => ({ call: vi.fn(), teamMove: vi.fn() }));
vi.mock("../lib/rpc", () => ({ core: { call: mocks.call, onInvalidate: () => {}, onReady: () => {} } }));
vi.mock("../lib/ui", () => ({ useUi: { getState: () => ({ setTeamMoveThread: mocks.teamMove }) } }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const task: Task = {
  id: "task",
  projectId: "project",
  title: "Task",
  spec: "Draft",
  status: "backlog",
  priority: "none",
  labels: [],
  workspaceMode: "current",
  baseRef: "main",
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
const owner = { id: "owner", importedFrom: null, workspaceMode: "worktree", branch: "openorc/owner", activity: "idle", taskCount: 1 };
function renderSettings(value = task, beforeChange = vi.fn(async () => true)) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  client.setQueryData(["runs.listForTask", { taskId: value.id }], []);
  client.setQueryData(["tasks.forwarding", { taskId: value.id }], { forwarding: null });
  client.setQueryData(["tasks.executionThread", { taskId: value.id }], value.executionThreadId ? owner : null);
  client.setQueryData(["orchestration.taskState", { taskId: value.id }], null);
  client.setQueryData(["projects.git", { id: value.projectId }], "ready");
  function Fixture() {
    return <TaskExecutionSettings execution={useTaskExecutionLocation(value, beforeChange)} />;
  }
  render(
    <QueryClientProvider client={client}>
      <Fixture />
    </QueryClientProvider>,
  );
  return { client, beforeChange };
}

it("waits for document saving, retains the selected location on failure, and permits retry", async () => {
  let finish!: (value: boolean) => void;
  const before = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  mocks.call.mockImplementation(async (method) => {
    if (method === "tasks.update") throw Error("Save failed");
    if (method === "tasks.executionThread") return null;
    return method === "runs.listForTask" ? [] : { forwarding: null };
  });
  renderSettings(task, before);
  const select = screen.getByRole("combobox", { name: "Execution location" });
  fireEvent.change(select, { target: { value: "worktree" } });
  expect(screen.getByRole("status").textContent).toContain("Saving");
  expect(mocks.call).not.toHaveBeenCalled();
  await act(async () => finish(true));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Save failed Choose the location again to retry.");
  expect(select).toHaveProperty("value", "current");
  expect(select).toHaveProperty("disabled", false);
  expect(mocks.call).toHaveBeenCalledWith("tasks.update", { id: task.id, patch: { workspaceMode: "worktree" } });
  expect(mocks.call.mock.calls.some(([method]) => method === "tasks.openThread" || method === "threads.moveWorkspace")).toBe(false);
});

it("uses the linked thread location and resolves its owner before requesting a move", async () => {
  mocks.call.mockImplementation(async (method) => {
    if (method === "tasks.openThread") return { id: "resolved-owner" };
    if (method === "threads.moveWorkspace") return { workspaceMode: "current" };
    if (method === "tasks.executionThread") return owner;
    if (method === "runs.listForTask") return [];
    if (method === "orchestration.taskState") return null;
    return { forwarding: null };
  });
  renderSettings({ ...task, threadId: "creator", executionThreadId: "owner" });
  const select = screen.getByRole("combobox", { name: "Execution location" });
  expect(select).toHaveProperty("value", "worktree");
  expect(screen.getByText(/moves this task’s execution conversation/)).toBeTruthy();
  fireEvent.change(select, { target: { value: "current" } });
  await waitFor(() => expect(mocks.call).toHaveBeenCalledWith("threads.moveWorkspace", { id: "resolved-owner", to: "current" }));
  expect(mocks.call.mock.calls.some(([method]) => method === "tasks.update")).toBe(false);
});

it("blocks a running conversation and exposes the saved-team move flow", async () => {
  const { client } = renderSettings({ ...task, threadId: "creator", executionThreadId: "owner" });
  await act(async () => {
    client.setQueryData(["tasks.executionThread", { taskId: task.id }], { ...owner, activity: "running" });
  });
  await waitFor(() => expect(screen.getByRole("combobox")).toHaveProperty("disabled", true));
  expect(screen.getByText(/Wait for the current turn/)).toBeTruthy();
  await act(async () => {
    client.setQueryData(["orchestration.taskState", { taskId: task.id }], { ownerDeletedAt: null });
  });
  fireEvent.click(await screen.findByRole("button", { name: "Manage team workspace" }));
  expect(mocks.teamMove).toHaveBeenCalledWith("creator");
  expect(mocks.call).not.toHaveBeenCalled();
});

it("keeps an unstarted task editable even when its creator is busy", async () => {
  mocks.call.mockImplementation(async (method) => {
    if (method === "tasks.update") return { ...task, workspaceMode: "worktree" };
    if (method === "tasks.executionThread" || method === "orchestration.taskState") return null;
    return method === "runs.listForTask" ? [] : { forwarding: null };
  });
  const { client } = renderSettings({ ...task, threadId: "creator", baseSha: "viewed-diff-base" });
  client.setQueryData(["threads.get", { id: "creator" }], { ...owner, id: "creator", activity: "running" });
  const select = screen.getByRole("combobox", { name: "Execution location" });
  expect(select).toHaveProperty("disabled", false);
  fireEvent.change(select, { target: { value: "worktree" } });
  await waitFor(() => expect(mocks.call).toHaveBeenCalledWith("tasks.update", { id: task.id, patch: { workspaceMode: "worktree" } }));
  expect(mocks.call.mock.calls.some(([method]) => method === "threads.moveWorkspace" || method === "tasks.openThread")).toBe(false);
});

it("does not move a shared creator conversation from one task's settings", () => {
  renderSettings({ ...task, threadId: "owner", executionThreadId: "owner" });
  expect(screen.getByRole("combobox", { name: "Execution location" })).toHaveProperty("disabled", true);
  expect(screen.getByText(/shares its execution conversation/)).toBeTruthy();
});

it("keeps a worktree out of reach until the project has a first commit, without extra copy", async () => {
  const { client } = renderSettings();
  await act(async () => {
    client.setQueryData(["projects.git", { id: task.projectId }], "no_commits");
  });
  const worktree = screen.getByRole("option", { name: "Worktree" });
  await waitFor(() => expect(worktree).toHaveProperty("disabled", true));
  expect(screen.getByText("This choice is saved for when work starts. Saving it does not start an agent or create a worktree.")).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Execution location" })).toHaveProperty("disabled", false);
  expect(mocks.call).not.toHaveBeenCalled();
});
