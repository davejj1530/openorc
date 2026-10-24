import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Project, RpcMethod, RpcResults, ThreadSummary } from "@openorc/protocol";
import { useLayout } from "../lib/layout";
import { usePanelSessions } from "../lib/panel-tabs";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { Panel } from "./Panel";

vi.mock("../lib/window", () => ({ useTrafficLights: () => false, useWindowsControls: () => false }));
vi.mock("../panels/BrowserPanel", () => ({
  BrowserPanel: () => (
    <>
      <input aria-label="Handles Escape" onKeyDown={(event) => event.preventDefault()} />
      <input aria-label="Ignores Escape" />
    </>
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
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
  vi.stubGlobal("openorc", { browser: { setContext: vi.fn(), onReveal: () => () => {}, close: vi.fn(), navigate: vi.fn() } });
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M): Promise<RpcResults[M]> => {
    if (method === "projects.git") return "none" as RpcResults[M];
    return [] as unknown as RpcResults[M];
  });
  usePanelSessions.setState({ sessions: {} });
  usePanelSessions.getState().open("thread:thread", { kind: "browser", url: "", title: "" });
  useLayout.setState({ panelOpen: true, panelTab: "browser", panelRequest: null, panelThreadId: thread.id, selectedChanges: null, selectedFile: null, panelExpanded: true, previewUrls: {} });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderExpandedPanel() {
  render(
    <QueryClientProvider client={queryClient}>
      <Panel context={{ kind: "thread", thread, project }} />
    </QueryClientProvider>,
  );
  expect(screen.getByRole("button", { name: "Collapse panel" })).toBeTruthy();
}

it("collapses an expanded panel on Escape", async () => {
  renderExpandedPanel();
  fireEvent.keyDown(await screen.findByRole("textbox", { name: "Ignores Escape" }), { key: "Escape" });
  expect(screen.getByRole("button", { name: "Expand panel" })).toBeTruthy();
  expect(useLayout.getState().panelExpanded).toBe(false);
});

it("stays expanded when what had focus already handled Escape, as an editor does", async () => {
  renderExpandedPanel();
  fireEvent.keyDown(await screen.findByRole("textbox", { name: "Handles Escape" }), { key: "Escape" });
  expect(screen.getByRole("button", { name: "Collapse panel" })).toBeTruthy();
  expect(useLayout.getState().panelExpanded).toBe(true);
});
