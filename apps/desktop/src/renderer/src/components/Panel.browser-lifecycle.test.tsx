import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Project, RpcMethod, RpcResults, ThreadSummary } from "@openorc/protocol";
import type { BrowserPaneState } from "../../../shared/types";
import { CoversPreview } from "../lib/browser-preview";
import { useLayout } from "../lib/layout";
import { queryClient } from "../lib/query";
import { core } from "../lib/rpc";
import { Panel } from "./Panel";

vi.mock("../lib/window", () => ({ useTrafficLights: () => false, useWindowsControls: () => false }));

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
const page: BrowserPaneState = { url: "http://localhost:3000", title: "Preview", loading: false, error: null, canGoBack: false, canGoForward: false };
const visible = new Set<string>();
let capture: PromiseWithResolvers<string | null>;
let showing: Promise<BrowserPaneState>;

beforeEach(() => {
  visible.clear();
  capture = Promise.withResolvers();
  showing = Promise.resolve(page);
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("openorc", {
    browser: {
      setContext: vi.fn(),
      onReveal: () => () => {},
      onState: () => () => {},
      show: async ({ id }: { id: string }) => {
        visible.add(id);
        return showing;
      },
      hide: (id: string) => visible.delete(id),
      capture: () => capture.promise,
      setBounds: () => {},
    },
  });
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M): Promise<RpcResults[M]> => {
    if (method === "projects.git") return "none" as RpcResults[M];
    return [] as unknown as RpcResults[M];
  });
  useLayout.setState({ panelOpen: true, panelTab: "browser", panelThreadId: thread.id, panelTools: {}, previewUrls: {}, selectedChanges: null, selectedFile: null, panelExpanded: false });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openPreview() {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Panel context={{ kind: "thread", thread, project }} />
    </QueryClientProvider>,
  );
  await screen.findByRole("textbox", { name: "Preview address" });
  expect([...visible]).toEqual(["thread:thread"]);
  return view;
}

it.each(["button", "tab"])("hides the native preview when the %s closes the panel, before the close animation ends", async (role) => {
  await openPreview();
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole(role, { name: role === "button" ? "Hide panel" : "Preview" }));
  expect(useLayout.getState().panelOpen).toBe(false);
  expect(document.querySelector(".panel-shell")?.getAttribute("aria-hidden")).toBe("true");
  expect([...visible]).toEqual([]);
  await act(async () => vi.advanceTimersByTime(250));
  expect([...visible]).toEqual([]);
});

it("does not reveal the native preview when a covering layer closes during the panel's close animation", async () => {
  await openPreview();
  const layer = render(<CoversPreview />);
  await act(async () => capture.resolve(null));
  expect([...visible]).toEqual([]);
  vi.useFakeTimers();
  act(() => useLayout.getState().setPanel(false));
  layer.unmount();
  expect([...visible]).toEqual([]);
  await act(async () => vi.advanceTimersByTime(250));
  expect([...visible]).toEqual([]);
});

it("keeps a late load response from revealing a closed preview", async () => {
  const loading = Promise.withResolvers<BrowserPaneState>();
  showing = loading.promise;
  await openPreview();
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name: "Hide panel" }));
  expect([...visible]).toEqual([]);
  await act(async () => loading.resolve(page));
  await act(async () => vi.advanceTimersByTime(250));
  expect([...visible]).toEqual([]);
});

it("keeps the old page hidden when switching to a new thread while the panel closes", async () => {
  const view = await openPreview();
  vi.useFakeTimers();
  act(() => useLayout.getState().setPanel(false));
  view.rerender(
    <QueryClientProvider client={queryClient}>
      <Panel context={{ kind: "newthread", project, workingDirectory: project.rootPath, changes: false }} />
    </QueryClientProvider>,
  );
  expect([...visible]).toEqual([]);
  await act(async () => vi.advanceTimersByTime(250));
  expect([...visible]).toEqual([]);
  await act(async () => useLayout.getState().setPanel(true, "browser"));
  expect([...visible]).toEqual(["newthread:project"]);
});
