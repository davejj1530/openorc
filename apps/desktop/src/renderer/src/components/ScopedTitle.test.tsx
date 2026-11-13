import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcMethod, RpcParams, RpcResults } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { ALL_WORKSPACES, useLayout } from "../lib/layout";
import { core } from "../lib/rpc";
import { ScopedTitle } from "./ScopedTitle";

const project = (id: string, name: string) => ({ id, name, rootPath: `/repo/${id}`, gitRemote: null, defaultBranch: "main", settings: {}, createdAt: 0, updatedAt: 0 });

beforeEach(() => {
  queryClient.clear();
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M, _params: RpcParams<M>): Promise<RpcResults[M]> => {
    if (method === "projects.list") return [project("studio", "studio"), project("site", "website")] as unknown as RpcResults[M];
    return [] as unknown as RpcResults[M];
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useLayout.setState({ sidebarOpen: true, workspace: ALL_WORKSPACES });
});

const mount = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <ScopedTitle>Tasks</ScopedTitle>
    </QueryClientProvider>,
  );

it("leads the title with the focused project while the sidebar is hidden, and the project changes the filter", async () => {
  useLayout.setState({ sidebarOpen: false, workspace: "studio" });
  const { container } = mount();
  const crumb = await screen.findByRole("button", { name: "Project: studio" });
  expect(container.textContent).toBe("studio/Tasks");
  fireEvent.click(crumb);
  fireEvent.click(await screen.findByRole("menuitem", { name: "website" }));
  expect(useLayout.getState().workspace).toBe("site");
});

it("keeps the plain title while the sidebar shows or no project is focused", () => {
  useLayout.setState({ sidebarOpen: true, workspace: "studio" });
  const shown = mount();
  expect(shown.container.textContent).toBe("Tasks");
  shown.unmount();
  useLayout.setState({ sidebarOpen: false, workspace: ALL_WORKSPACES });
  expect(mount().container.textContent).toBe("Tasks");
});
