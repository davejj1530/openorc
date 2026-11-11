import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { useUi } from "../lib/ui";
import { RemoveWorktreeDialog } from "./RemoveWorktreeDialog";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
  useUi.getState().setRemoveWorktree(null);
});

function show(failed: { owner: { kind: "thread"; id: string }; message: string }[]) {
  vi.mocked(core.call).mockImplementation(async (method: string) => {
    if (method === "threads.get") return { id: "t1", title: "Add a footer" } as never;
    if (method === "worktrees.remove") return { removed: failed.length ? [] : [{ kind: "thread", id: "t1" }], failed } as never;
    return null as never;
  });
  useUi.getState().setRemoveWorktree("t1");
  render(
    <QueryClientProvider client={queryClient}>
      <RemoveWorktreeDialog />
    </QueryClientProvider>,
  );
}

it("says what stays, removes the thread's worktree and closes", async () => {
  show([]);
  expect(await screen.findByText("Add a footer")).toBeTruthy();
  expect(screen.getByText(/The branch and the conversation stay/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("worktrees.remove", { owners: [{ kind: "thread", id: "t1" }] }));
  await waitFor(() => expect(useUi.getState().removeWorktreeThreadId).toBeNull());
});

it("keeps the dialog open with the reason when the worktree stays", async () => {
  show([{ owner: { kind: "thread", id: "t1" }, message: "In use. Wait for its turn, approval or background commands to finish." }]);
  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
  expect(await screen.findByText("In use. Wait for its turn, approval or background commands to finish.")).toBeTruthy();
  expect(useUi.getState().removeWorktreeThreadId).toBe("t1");
});
