import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

it("lists every project's threads for a layout saved before the project filter", async () => {
  localStorage.setItem("openorc.layout", JSON.stringify({ projectId: "one" }));
  const { ALL_WORKSPACES, focusedProject, useLayout } = await import("./layout");
  expect(useLayout.getState()).toMatchObject({ workspace: ALL_WORKSPACES });
  expect(focusedProject(useLayout.getState())).toBeNull();
});

it("opens the sidebar at its default width over a width the rail's layout saved for the list beside it, then keeps its own", async () => {
  localStorage.setItem("openorc.layout", JSON.stringify({ sidebarWidth: 300 }));
  const first = await import("./layout");
  expect(first.useLayout.getState().sidebarWidth).toBe(first.limits.sidebar.default);
  first.useLayout.getState().setSidebarWidth(320);
  vi.resetModules();
  const second = await import("./layout");
  expect(second.useLayout.getState().sidebarWidth).toBe(320);
});

it("remembers the filter's project across launches", async () => {
  const first = await import("./layout");
  first.useLayout.getState().setWorkspace("two");
  expect(first.focusedProject(first.useLayout.getState())).toBe("two");
  vi.resetModules();
  const second = await import("./layout");
  expect(second.useLayout.getState().workspace).toBe("two");
});

it("brings a focused filter along to work opened elsewhere, Workspace's under All projects, and leaves All as it is", async () => {
  const { ALL_WORKSPACES, useLayout } = await import("./layout");
  const { WORKSPACE_ID } = await import("@openorc/protocol");
  useLayout.getState().setWorkspace("one");
  useLayout.getState().followProject("two");
  expect(useLayout.getState().workspace).toBe("two");
  useLayout.getState().followProject(WORKSPACE_ID);
  expect(useLayout.getState().workspace).toBe(ALL_WORKSPACES);
  useLayout.getState().followProject("three");
  expect(useLayout.getState().workspace).toBe(ALL_WORKSPACES);
});

it("keeps a closed panel shut for agents once the person turns that off, across launches, and still opens it by hand", async () => {
  const first = await import("./layout");
  first.useLayout.getState().showForAgent();
  expect(first.useLayout.getState().panelOpen).toBe(true);
  first.useLayout.getState().setPanel(false);
  first.useLayout.getState().setAgentsOpenPanel(false);
  vi.resetModules();
  const { useLayout } = await import("./layout");
  useLayout.getState().showForAgent();
  useLayout.getState().showForAgent({ id: "thread", tab: "plan" });
  expect(useLayout.getState()).toMatchObject({ panelOpen: false, panelRequest: null });
  useLayout.getState().setPanel(true);
  useLayout.getState().showForAgent({ id: "thread", tab: "plan" });
  expect(useLayout.getState()).toMatchObject({ panelOpen: true, panelThreadId: "thread", panelTab: "plan" });
});
