import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Project, ThreadSummary } from "@openorc/protocol";
import { useLayout } from "../lib/layout";
import { usePanelSessions } from "../lib/panel-tabs";
import { queryClient } from "../lib/client";
import { Panel } from "./Panel";

vi.mock("../lib/window", () => ({ useTrafficLights: () => false, useWindowsControls: () => false }));
vi.mock("../panels/MemoryPanel", () => ({ MemoryPanel: () => <div>Project memory</div> }));
vi.mock("../panels/TerminalPanel", () => ({ TerminalPanel: ({ id }: { id: string }) => <div>Shell {id}</div> }));
vi.mock("../panels/BrowserPanel", () => ({
  BrowserPanel: ({ id, defaultUrl }: { id: string; defaultUrl: string }) => (
    <div data-testid="browser" data-id={id}>
      {defaultUrl}
    </div>
  ),
}));
const project: Project = {
  id: "project",
  name: "Site",
  rootPath: "/tmp/site",
  gitRemote: null,
  defaultBranch: "main",
  settings: { setupScript: null, worktreeInclude: [], branchPrefix: "openorc", detectedConfigs: [] },
  createdAt: 0,
  updatedAt: 0,
};
const thread = { id: "thread", projectId: project.id, workspaceMode: "current", createdAt: 0 } as ThreadSummary;

beforeEach(() => {
  usePanelSessions.setState({ sessions: {} });
  useLayout.setState({ panelOpen: true, panelTab: "newtab", panelRequest: null, panelThreadId: thread.id, selectedFile: null, selectedChanges: null, panelExpanded: false, previewUrls: {} });
  vi.stubGlobal("openorc", { browser: { setContext: vi.fn(), onReveal: () => () => {}, close: vi.fn(), navigate: vi.fn() } });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
});

function mount() {
  return render(
    <QueryClientProvider client={queryClient}>
      <Panel context={{ kind: "thread", thread, project }} />
    </QueryClientProvider>,
  );
}

it("opens with a launcher, uses its tab for a tool without browser controls, and keeps clicking the active tab open", async () => {
  mount();
  expect(screen.getAllByRole("tab")).toHaveLength(1);
  expect(screen.getByRole("tab", { name: "New tab" })).toBeTruthy();
  expect(within(screen.getByRole("tabpanel")).getByRole("button", { name: "Back" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Memory" }));
  expect(await screen.findByText("Project memory")).toBeTruthy();
  expect(within(screen.getByRole("tabpanel")).queryByRole("button", { name: "Back" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Memory" }));
  expect(useLayout.getState().panelOpen).toBe(true);
  expect(screen.getByText("Project memory")).toBeTruthy();
});

it("adds and closes tabs, supports arrow navigation, and restores a reopened panel", async () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Memory" }));
  fireEvent.click(screen.getByRole("button", { name: "New tab" }));
  fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
  expect(await screen.findByText("Shell thread:thread")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("tab", { name: "Terminal" }), { key: "ArrowLeft" });
  expect(screen.getByText("Project memory")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close Terminal" }));
  expect(screen.getAllByRole("tab")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Hide panel" }));
  act(() => useLayout.getState().setPanel(true));
  expect(screen.getByRole("tab", { name: "Memory" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Close Memory" }));
  expect(screen.getByRole("tab", { name: "New tab" })).toBeTruthy();
});

it("opens independent website tabs and releases only the closed page", async () => {
  mount();
  const visit = (url: string) => {
    const address = screen.getByRole("textbox", { name: "Preview address" });
    fireEvent.change(address, { target: { value: url } });
    fireEvent.submit(address.closest("form")!);
  };
  visit("https://one.example");
  expect(await screen.findByText("https://one.example")).toBeTruthy();
  const firstId = screen.getByTestId("browser").getAttribute("data-id");
  fireEvent.click(screen.getByRole("button", { name: "New tab" }));
  visit("https://two.example");
  expect(await screen.findByText("https://two.example")).toBeTruthy();
  const secondId = screen.getByTestId("browser").getAttribute("data-id");
  expect(secondId).not.toBe(firstId);
  fireEvent.click(screen.getByRole("button", { name: "Close two.example" }));
  expect(window.openorc.browser.close).toHaveBeenCalledExactlyOnceWith(secondId);
  expect(screen.getByTestId("browser").getAttribute("data-id")).toBe(firstId);
});

it("restores each thread's tabs after remounting without repeating an old tool request", async () => {
  const view = mount();
  act(() => useLayout.getState().openThreadPanel(thread.id, "memory"));
  expect(await screen.findByText("Project memory")).toBeTruthy();
  view.unmount();
  const next = render(
    <QueryClientProvider client={queryClient}>
      <Panel context={{ kind: "thread", thread: { ...thread, id: "other" }, project }} />
    </QueryClientProvider>,
  );
  expect(screen.getAllByRole("tab")).toHaveLength(1);
  expect(screen.getByRole("tab", { name: "New tab" })).toBeTruthy();
  next.unmount();
  mount();
  expect(screen.getByRole("tab", { name: "Memory" })).toBeTruthy();
});
