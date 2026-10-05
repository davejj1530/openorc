import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Project, RpcMethod, RpcResults, ThreadSummary } from "@openorc/protocol";
import { useLayout } from "../lib/layout";
import { queryClient } from "../lib/query";
import { core } from "../lib/rpc";
import { Panel } from "./Panel";

vi.mock("../lib/window", () => ({ useTrafficLights: () => false, useWindowsControls: () => false }));
vi.mock("../panels/BrowserPanel", () => ({ BrowserPanel: () => <div role="region" aria-label="Web preview" /> }));

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
const listeners = new Set<(id: string) => void>();

beforeEach(() => {
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
  vi.stubGlobal("openorc", {
    browser: {
      setContext: vi.fn(),
      onReveal: (callback: (id: string) => void) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    },
  });
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M): Promise<RpcResults[M]> => {
    if (method === "projects.git") return "none" as RpcResults[M];
    return [] as unknown as RpcResults[M];
  });
  useLayout.setState({ panelOpen: false, panelTab: "changes", panelThreadId: thread.id, panelTools: {}, selectedChanges: null, selectedFile: null, panelExpanded: false });
});

afterEach(() => {
  cleanup();
  listeners.clear();
  queryClient.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["changes", "browser"] as const)("reveals the linked page when the closed panel's saved tab is %s", async (panelTab) => {
  useLayout.setState({ panelTab });
  render(
    <QueryClientProvider client={queryClient}>
      <Panel context={{ kind: "thread", thread, project }} />
    </QueryClientProvider>,
  );
  act(() => {
    for (const callback of listeners) callback("thread:thread");
  });
  expect((await screen.findByRole("tab", { name: "Preview" })).getAttribute("aria-selected")).toBe("true");
  expect(await screen.findByRole("region", { name: "Web preview" })).toBeTruthy();
  expect(useLayout.getState().panelTools["thread:thread"]).toContain("browser");
});
