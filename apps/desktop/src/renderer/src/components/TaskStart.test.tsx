import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Task, Thread } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { TaskStart } from "./TaskStart";
import { core } from "../lib/rpc";
import { useRouter } from "../lib/router";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onInvalidate: vi.fn(), onReady: vi.fn() } }));
const task: Task = {
  id: "task",
  projectId: "project",
  title: "Export rows",
  spec: "Save CSV",
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
const conversation: Thread = {
  id: "conversation",
  projectId: "project",
  title: "Export rows",
  agent: "codex",
  model: null,
  effort: null,
  fastMode: false,
  mode: "act",
  permissionMode: "trusted",
  workspaceMode: "current",
  branch: null,
  worktreePath: null,
  baseSha: null,
  pinnedAt: null,
  seenAt: null,
  doneAt: null,
  snoozedUntil: null,
  prUrl: null,
  prState: null,
  forkedFromId: null,
  forkedAtRunId: null,
  draft: "Save CSV",
  importedFrom: null,
  createdAt: 1,
  updatedAt: 1,
  lastActivityAt: 1,
  archivedAt: null,
};
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function show() {
  useRouter.setState({ route: { view: "tasks" }, threadIds: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TaskStart task={task} />
    </QueryClientProvider>,
  );
}
it("keeps a failed open in place and allows retry", async () => {
  vi.mocked(core.call).mockRejectedValueOnce(new Error("Conversation could not open")).mockResolvedValueOnce(conversation);
  show();
  fireEvent.click(screen.getByRole("button", { name: "Open thread for Export rows" }));
  await screen.findByRole("alert");
  expect(useRouter.getState().route.view).toBe("tasks");
  fireEvent.click(screen.getByRole("button", { name: "Open thread for Export rows" }));
  await waitFor(() => expect(useRouter.getState().route.view).toBe("thread"));
});
