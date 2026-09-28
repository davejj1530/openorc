import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Task, TaskForwarding as ForwardingRecord, type TaskForwardingState } from "@openorc/protocol";
import { TaskForwarding } from "./TaskForwarding";

const mocks = vi.hoisted(() => ({ call: vi.fn(), flushTaskDraft: vi.fn(), openTask: vi.fn() }));
vi.mock("../lib/rpc", () => ({ core: { call: mocks.call, onInvalidate: () => {}, onReady: () => {} } }));
vi.mock("../lib/router", () => ({ openTask: mocks.openTask }));
vi.mock("../lib/task-draft-context", () => ({ useTaskDraftActions: () => ({ flushTaskDraft: mocks.flushTaskDraft }) }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const task = Task.parse({
  id: "source",
  projectId: "project",
  threadId: "team",
  parentTaskId: null,
  title: "Forward me",
  spec: "Saved draft",
  status: "backlog",
  priority: "none",
  labels: [],
  workspaceMode: "worktree",
  worktreePath: null,
  baseRef: null,
  baseSha: null,
  branch: null,
  origin: "agent",
  reviewedSnapshotId: null,
  costUsd: 0,
  createdAt: 1,
  updatedAt: 1,
  completedAt: null,
});
function mount(state: TaskForwardingState, selected = task) {
  mocks.call.mockImplementation(async (method: string) => {
    if (method === "tasks.forwarding") return state;
    if (method === "review.checkoutState") return { allowed: true, reason: null, preview: null };
    if (method === "tasks.forward") return { ...task, id: "target", threadId: null };
    throw new Error(method);
  });
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <TaskForwarding task={selected} team={Boolean(selected.threadId)}>
        <p>Agent controls</p>
      </TaskForwarding>
    </QueryClientProvider>,
  );
}
describe("task handoff controls", () => {
  it("honors the workspace preference and saves the draft before forwarding and opening the independent task", async () => {
    let saved!: () => void;
    mocks.flushTaskDraft.mockReturnValue(
      new Promise<void>((resolve) => {
        saved = resolve;
      }),
    );
    mount({ allowed: true, reason: null, workspaceMode: "current", forwarding: null });
    await vi.waitFor(() => expect((screen.getByRole("button", { name: "Forward to another agent" }) as HTMLButtonElement).disabled).toBe(false));
    await vi.waitFor(() => expect((screen.getByLabelText("Forwarded task workspace") as HTMLSelectElement).value).toBe("current"));
    fireEvent.click(screen.getByRole("button", { name: "Forward to another agent" }));
    expect(mocks.flushTaskDraft).toHaveBeenCalledWith("source");
    expect(mocks.call.mock.calls.some((call) => call[0] === "tasks.forward")).toBe(false);
    saved();
    await vi.waitFor(() => expect(mocks.openTask).toHaveBeenCalledWith("target", "chat"));
    expect(mocks.call).toHaveBeenCalledWith("tasks.forward", { taskId: "source", workspaceMode: "current" });
  });

  it("explains why active work cannot be forwarded", async () => {
    mount({ allowed: false, reason: "Finish or stop the current assignment.", workspaceMode: "worktree", forwarding: null });
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "Finish or stop the current assignment.");
    expect((screen.getByRole("button", { name: "Forward to another agent" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Agent controls")).toBeTruthy();
  });

  it("keeps a pending destination from displaying agent controls and links back to recovery", async () => {
    const forwarding = ForwardingRecord.parse({
      sourceTaskId: "source",
      targetTaskId: "target",
      sourceThreadId: "team",
      workspaceMode: "current",
      state: "preparing",
      context: "Previous task result",
      snapshot: null,
      baseSha: null,
      stagingPath: null,
      previewId: null,
      error: "Resolve the checkout conflict.",
      createdAt: 1,
    });
    mount({ allowed: false, reason: null, workspaceMode: "current", forwarding }, { ...task, id: "target", threadId: null });
    fireEvent.click(await screen.findByRole("button", { name: "Open original task" }));
    expect(mocks.openTask).toHaveBeenCalledWith("source", "chat");
    expect(screen.queryByText("Agent controls")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("Resolve the checkout conflict.");
  });
});
