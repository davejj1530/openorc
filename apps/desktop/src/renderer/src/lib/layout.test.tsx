import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

it("lists every project's threads for a layout saved before the rail, keeping its current project", async () => {
  localStorage.setItem("openorc.layout", JSON.stringify({ projectId: "one", sidebarWidth: 300 }));
  const { ALL_WORKSPACES, useLayout } = await import("./layout");
  expect(useLayout.getState()).toMatchObject({ workspace: ALL_WORKSPACES, projectId: "one", sidebarWidth: 300 });
});

it("remembers the rail's workspace across launches, and choosing All keeps the current project", async () => {
  const first = await import("./layout");
  first.useLayout.getState().setWorkspace("two");
  expect(first.useLayout.getState()).toMatchObject({ workspace: "two", projectId: "two" });
  vi.resetModules();
  const second = await import("./layout");
  expect(second.useLayout.getState().workspace).toBe("two");
  second.useLayout.getState().setWorkspace(second.ALL_WORKSPACES);
  expect(second.useLayout.getState()).toMatchObject({ workspace: second.ALL_WORKSPACES, projectId: "two" });
});
