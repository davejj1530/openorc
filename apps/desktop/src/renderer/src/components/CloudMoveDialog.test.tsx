import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ThreadSummary } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { CloudMoveDialog } from "./CloudMoveDialog";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { useUi } from "../lib/ui";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
  useUi.getState().setMoveThread(null);
});

function thread(workspaceMode: "current" | "worktree"): ThreadSummary {
  return {
    id: "thread",
    projectId: "project",
    title: "Add a footer",
    agent: "claude",
    model: null,
    effort: null,
    fastMode: false,
    mode: "act",
    permissionMode: "review",
    workspaceMode,
    branch: workspaceMode === "worktree" ? "openorc/footer" : null,
    worktreePath: workspaceMode === "worktree" ? "/tmp/footer" : null,
    baseSha: null,
    baseBranch: "main",
    pinnedAt: null,
    seenAt: null,
    doneAt: null,
    snoozedUntil: null,
    prUrl: null,
    prState: null,
    forkedFromId: null,
    forkedAtRunId: null,
    draft: "",
    importedFrom: null,
    createdAt: 0,
    updatedAt: 0,
    lastActivityAt: 0,
    archivedAt: null,
    activity: "idle",
    unread: false,
    session: { status: "idle", message: null },
    context: null,
    queued: [],
    lastAgentEventAt: null,
    taskCount: 0,
    openTaskCount: 0,
  };
}

function show(mode: "current" | "worktree", move: () => Promise<unknown> = async () => thread(mode)) {
  vi.mocked(core.call).mockImplementation((async (method: string) => {
    if (method === "threads.get") return thread(mode);
    if (method === "threads.movePreview") return { files: [{ path: "src/footer.tsx", status: "modified", oldPath: null }], blocked: null };
    if (method === "cloud.move") return move();
    return null;
  }) as never);
  useUi.getState().setMoveThread("thread", "cloud");
  render(
    <QueryClientProvider client={queryClient}>
      <CloudMoveDialog threadId="thread" />
    </QueryClientProvider>,
  );
}

it("moves a worktree conversation to the cloud and closes", async () => {
  show("worktree");
  await screen.findByText("Add a footer");
  expect(screen.getByText(/Its worktree, uncommitted changes and session go to a sandbox of its own/)).toBeTruthy();
  expect(core.call).not.toHaveBeenCalledWith("threads.movePreview", expect.anything());
  fireEvent.click(screen.getByRole("button", { name: "Move" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.move", { threadId: "thread" }));
  await waitFor(() => expect(useUi.getState().moveThreadId).toBeNull());
});

it("lists the files a checkout conversation takes with it, and shows a refusal in place", async () => {
  show("current", async () => {
    throw new Error("“Work” has no token for cloud threads. Create one in Settings → Cloud.");
  });
  await screen.findByText("src/footer.tsx");
  expect(screen.getByText(/Every uncommitted change in the checkout first moves into a new worktree/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Move" }));
  expect((await screen.findByRole("alert")).textContent).toBe("“Work” has no token for cloud threads. Create one in Settings → Cloud.");
  expect(useUi.getState().moveThreadId).toBe("thread");
});
