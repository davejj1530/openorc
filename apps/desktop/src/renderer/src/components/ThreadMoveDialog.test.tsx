import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ChangePreview } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { core } from "../lib/rpc";
import { queryClient } from "../lib/query";
import { useUi } from "../lib/ui";
import { ThreadMoveDialog } from "./ThreadMoveDialog";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onInvalidate: vi.fn(), onReady: vi.fn() } }));
let preview: ChangePreview;
beforeEach(() => {
  preview = {
    files: [
      { path: "src/app.ts", status: "modified", oldPath: null },
      { path: "big.bin", status: "added", oldPath: null },
    ],
    blocked: null,
  };
  vi.mocked(core.call).mockImplementation(async (method, params) => {
    if (method === "threads.get") return { id: "t1", title: "Move me", workspaceMode: "current" };
    if (method === "threads.movePreview") return preview;
    if (method === "threads.moveWorkspace") return { id: "t1", workspaceMode: (params as { to: string }).to };
    throw new Error(`Unexpected RPC: ${method}`);
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  useUi.setState({ moveThreadId: null });
  vi.resetAllMocks();
});
function show() {
  useUi.setState({ moveThreadId: "t1" });
  render(
    <QueryClientProvider client={queryClient}>
      <ThreadMoveDialog />
    </QueryClientProvider>,
  );
}

it("lists the files that will move and moves on confirmation", async () => {
  show();
  expect(await screen.findByText("src/app.ts")).toBeTruthy();
  expect(screen.getByText("big.bin")).toBeTruthy();
  const button = screen.getByRole("button", { name: "Move" }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("threads.moveWorkspace", { id: "t1", to: "worktree" }));
  await waitFor(() => expect(useUi.getState().moveThreadId).toBeNull());
});

it("says why a move cannot run and does not offer it", async () => {
  preview = { files: [], blocked: 'This conversation cannot move. The submodule or nested repository at "vendor" changed.' };
  show();
  expect((await screen.findByRole("alert")).textContent).toContain("vendor");
  expect((screen.getByRole("button", { name: "Move" }) as HTMLButtonElement).disabled).toBe(true);
});
