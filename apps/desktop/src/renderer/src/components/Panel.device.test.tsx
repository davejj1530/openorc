import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { CorePush, Project, ThreadSummary } from "@openorc/protocol";
import { useLayout } from "../lib/layout";
import { activeTab, currentPage, usePanelSessions } from "../lib/panel-tabs";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { Panel } from "./Panel";

vi.mock("../lib/window", () => ({ useTrafficLights: () => false, useWindowsControls: () => false }));
// Stands in for the device view: its presence is what streams, so the test counts what is mounted.
vi.mock("../panels/DevicePanel", () => ({
  DevicePanel: ({ page }: { page: { deviceId: string | null } }) => <div role="region" aria-label={`Device view ${page.deviceId ?? "picker"}`} />,
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
const corePort = { onmessage: null as ((event: MessageEvent) => void) | null, start: vi.fn(), postMessage: vi.fn() };
const push = (data: Extract<CorePush, { type: "device.panel" }>) => act(() => corePort.onmessage?.(new MessageEvent("message", { data })));
const deviceViews = () => screen.queryAllByRole("region").map((region) => region.getAttribute("aria-label"));

beforeAll(() => {
  Object.defineProperty(window, "openorc", { configurable: true, writable: true, value: { connectBridge: vi.fn() } });
  core.connect();
  window.dispatchEvent(new MessageEvent("message", { data: "openorc:port", source: window, ports: [corePort as unknown as MessagePort] }));
});

beforeEach(() => {
  usePanelSessions.setState({ sessions: {} });
  useLayout.setState({ panelOpen: false, panelTab: "newtab", panelRequest: null, panelThreadId: thread.id, selectedFile: null, selectedChanges: null, panelExpanded: false, previewUrls: {} });
  vi.stubGlobal("openorc", { connectBridge: vi.fn(), browser: { setContext: vi.fn(), onReveal: () => () => {}, close: vi.fn(), navigate: vi.fn() }, terminal: { kill: vi.fn() } });
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

it("offers Device on the new tab page and opens its picker in that tab", async () => {
  useLayout.setState({ panelOpen: true });
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Device" }));
  expect(await screen.findByRole("region", { name: "Device view picker" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Device" }).getAttribute("aria-selected")).toBe("true");
});

it("shows the panel with the device when an agent opens one in the conversation on screen, and only there", async () => {
  mount();
  push({ type: "device.panel", surface: "thread:other", deviceId: "UDID-1", name: "iPhone 17", action: "open" });
  expect(useLayout.getState().panelOpen).toBe(false);
  expect(currentPage(activeTab(usePanelSessions.getState().sessions["thread:other"]!))).toEqual({ kind: "device", deviceId: "UDID-1", name: "iPhone 17" });
  push({ type: "device.panel", surface: "thread:thread", deviceId: "UDID-1", name: "iPhone 17", action: "open" });
  expect(useLayout.getState().panelOpen).toBe(true);
  expect(await screen.findByRole("region", { name: "Device view UDID-1" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "iPhone 17" }).getAttribute("aria-selected")).toBe("true");
});

it("mounts only the device on screen, and nothing once the panel hides", async () => {
  useLayout.setState({ panelOpen: true });
  mount();
  push({ type: "device.panel", surface: "thread:thread", deviceId: "UDID-1", name: "iPhone 17", action: "open" });
  push({ type: "device.panel", surface: "thread:thread", deviceId: "Pixel_9", name: "Pixel 9", action: "open" });
  expect(await screen.findByRole("region", { name: "Device view Pixel_9" })).toBeTruthy();
  expect(deviceViews()).toEqual(["Device view Pixel_9"]);
  fireEvent.click(screen.getByRole("tab", { name: "iPhone 17" }));
  expect(await screen.findByRole("region", { name: "Device view UDID-1" })).toBeTruthy();
  expect(deviceViews()).toEqual(["Device view UDID-1"]);
  act(() => useLayout.getState().setPanel(false));
  expect(deviceViews()).toEqual([]);
});

it("closing a device tab only drops it, and an agent's close drops its tab", async () => {
  useLayout.setState({ panelOpen: true });
  mount();
  push({ type: "device.panel", surface: "thread:thread", deviceId: "UDID-1", name: "iPhone 17", action: "open" });
  push({ type: "device.panel", surface: "thread:thread", deviceId: "Pixel_9", name: "Pixel 9", action: "open" });
  fireEvent.click(screen.getByRole("button", { name: "Close Pixel 9" }));
  expect(screen.queryByRole("tab", { name: "Pixel 9" })).toBeNull();
  expect(corePort.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ method: "devices.shutdown" }));
  push({ type: "device.panel", surface: "thread:thread", deviceId: "UDID-1", name: "iPhone 17", action: "close" });
  expect(screen.queryByRole("tab", { name: "iPhone 17" })).toBeNull();
});
