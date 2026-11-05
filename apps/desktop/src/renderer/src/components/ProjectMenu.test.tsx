import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WORKSPACE_ID } from "@openorc/protocol";
import { core } from "../lib/rpc";
import { queryClient } from "../lib/client";
import { useLayout } from "../lib/layout";
import { useRouter } from "../lib/router";
import { ProjectPicker } from "./ProjectPicker";

vi.mock("../lib/browser-preview", () => ({ CoversPreview: () => null }));
beforeEach(() => {
  useLayout.setState({ projectId: "repo", collapsed: [] });
  useRouter.setState({ route: { view: "thread", threadId: "running-thread" }, threadIds: ["running-thread"] });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});
/** The project list a new thread's question opens, where each project keeps its removal. */
function show(id = "repo", name = "Studio") {
  const workspace = { id: WORKSPACE_ID, name: "Workspace" };
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ProjectPicker projectId={id} projects={id === WORKSPACE_ID ? [workspace] : [workspace, { id, name, rootPath: "/code/studio" }]} onProject={() => {}} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: `Project: ${name}` }));
  return view;
}
async function confirmFromContextMenu(input: "pointer" | "keyboard" = "pointer") {
  const heading = await screen.findByRole("button", { name: "Studio" });
  if (input === "keyboard") fireEvent.keyDown(heading, { key: "F10", shiftKey: true });
  else fireEvent.contextMenu(heading);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Remove project…" }));
  return screen.findByRole("button", { name: "Remove project" });
}

it("offers removal on right-click without toggling the project, and cancellation makes no write", async () => {
  const call = vi.spyOn(core, "call");
  show();
  expect(screen.queryByRole("button", { name: /Project options/ })).toBeNull();
  fireEvent.contextMenu(await screen.findByRole("button", { name: "Studio" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Remove project…" }));
  expect((await screen.findByRole("dialog", { name: /Remove/ })).textContent).toContain("Files, worktrees, and history are kept");
  expect(useLayout.getState().collapsed).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: /Remove/ })).toBeNull());
  expect(call).not.toHaveBeenCalled();
});

it("removes through the keyboard context menu and resets its scope while keeping the open conversation", async () => {
  const call = vi.spyOn(core, "call").mockResolvedValue({ ok: true });
  show();
  fireEvent.click(await confirmFromContextMenu("keyboard"));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: /Remove/ })).toBeNull());
  expect(call).toHaveBeenCalledExactlyOnceWith("projects.remove", { id: "repo" });
  expect(useLayout.getState().projectId).toBe(WORKSPACE_ID);
  expect(useRouter.getState().route).toEqual({ view: "thread", threadId: "running-thread" });
});

it("keeps errors visible, prevents repeat submission while pending, and allows retry without changing another scope", async () => {
  let reject!: (error: Error) => void;
  const call = vi
    .spyOn(core, "call")
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    )
    .mockResolvedValue({ ok: true });
  useLayout.setState({ projectId: "other" });
  show();
  const remove = await confirmFromContextMenu();
  fireEvent.click(remove);
  await waitFor(() => expect(remove.hasAttribute("disabled")).toBe(true));
  fireEvent.click(remove);
  expect(call).toHaveBeenCalledTimes(1);
  reject(new Error("Could not save changes"));
  expect((await screen.findByRole("alert")).textContent).toBe("Could not save changes");
  expect(useLayout.getState().projectId).toBe("other");
  fireEvent.click(screen.getByRole("button", { name: "Remove project" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: /Remove/ })).toBeNull());
  expect(call).toHaveBeenCalledTimes(2);
  expect(useLayout.getState().projectId).toBe("other");
});

it("keeps Workspace permanent", async () => {
  show(WORKSPACE_ID, "Workspace");
  expect(screen.queryByRole("button", { name: /Project options/ })).toBeNull();
  fireEvent.contextMenu(await screen.findByRole("button", { name: "Workspace" }));
  expect(screen.queryByRole("menuitem", { name: "Remove project…" })).toBeNull();
});
