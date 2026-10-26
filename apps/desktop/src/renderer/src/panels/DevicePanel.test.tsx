import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Device, DeviceList, DeviceStatus, RpcMethod, RpcParams, RpcResults } from "@openorc/protocol";
import { useDeviceOperations } from "../lib/device/operations";
import { activeTab, currentPage, usePanelSessions, type DevicePage } from "../lib/panel-tabs";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { DevicePanel } from "./DevicePanel";

const scope = "thread:one";
const picker: DevicePage = { kind: "device", deviceId: null, name: "Device" };

const device = (id: string, platform: Device["platform"], os: string, state: Device["state"], formFactor: Device["formFactor"] = "phone"): Device => ({
  id,
  name: id,
  platform,
  os,
  formFactor,
  state,
});

const baseStatus: DeviceStatus = {
  settings: { enabled: true, agentAccess: true },
  helpers: { phase: "running" },
  platforms: [
    { platform: "ios", available: true, reason: null },
    { platform: "android", available: true, reason: null, video: { available: true, reason: null } },
  ],
  tools: [
    { name: "expo-device-hub", pinned: "0.18.0", installed: null },
    { name: "agent-device", pinned: "0.21.31", installed: null },
  ],
  blocked: null,
};
const baseList: DeviceList = {
  devices: [
    device("iPhone 17", "ios", "iOS 26.5", "shutdown"),
    device("iPad Pro", "ios", "iOS 26.5", "booted", "tablet"),
    device("iPhone 16", "ios", "iOS 18.6", "shutdown"),
    device("Pixel_9", "android", "Android API 36", "booted"),
    device("Pixel_8", "android", "Android API 34", "shutdown"),
  ],
  warnings: [],
};

let status: DeviceStatus;
let list: DeviceList;
let calls: Array<{ method: RpcMethod; params: unknown; operations: Record<string, unknown> }>;

beforeEach(() => {
  status = structuredClone(baseStatus);
  list = structuredClone(baseList);
  calls = [];
  usePanelSessions.setState({ sessions: {} });
  useDeviceOperations.setState({ operations: {} });
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> => {
    calls.push({ method, params, operations: { ...useDeviceOperations.getState().operations } });
    if (method === "devices.status" || method === "devices.setup") return status as RpcResults[M];
    if (method === "devices.list") return list as RpcResults[M];
    // By the time a boot returns, the core lists the device as running.
    if (method === "devices.boot") list = { ...list, devices: list.devices.map((entry) => (entry.id === (params as { deviceId: string }).deviceId ? { ...entry, state: "booted" } : entry)) };
    return { ok: true } as RpcResults[M];
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(page: DevicePage = picker) {
  usePanelSessions.getState().navigate(scope, page);
  const tabId = usePanelSessions.getState().sessions[scope]!.activeId;
  return render(
    <QueryClientProvider client={queryClient}>
      <DevicePanel scope={scope} tabId={tabId} page={page} />
    </QueryClientProvider>,
  );
}
const called = (method: RpcMethod) => calls.filter((call) => call.method === method).map((call) => call.params);

it("shows setup while device support is off, and opening it installs and starts nothing", async () => {
  status.settings = { enabled: false, agentAccess: true };
  status.platforms = [baseStatus.platforms[0]!, { platform: "android", available: false, reason: "Android needs the SDK platform-tools, emulator and cmdline-tools/latest." }];
  mount();
  expect(await screen.findByText("Simulators and emulators")).toBeTruthy();
  expect(screen.getByText("Android needs the SDK platform-tools, emulator and cmdline-tools/latest.")).toBeTruthy();
  expect(screen.getByText(/expo-device-hub 0\.18\.0 to stream and control devices, and agent-device 0\.21\.31/)).toBeTruthy();
  expect((screen.getByRole("switch", { name: "Agents can use devices" }) as HTMLInputElement).checked).toBe(true);
  expect(calls.map((call) => call.method)).toEqual(["devices.status"]);
  fireEvent.click(screen.getByRole("switch", { name: "Agents can use devices" }));
  expect(screen.queryByText(/agent-device/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Install and start" }));
  await waitFor(() => expect(called("devices.setup")).toEqual([{ agentAccess: false }]));
});

it("keeps setup's action off with the reason on demand when this Mac cannot run the tools", async () => {
  status.settings = { enabled: false, agentAccess: true };
  status.blocked = "Device support needs Node.js 22.12 or later.";
  mount();
  expect((await screen.findByRole("button", { name: "Install and start" })).hasAttribute("disabled")).toBe(true);
  expect(screen.queryByText("Device support needs Node.js 22.12 or later.")).toBeNull();
});

it("lists every device under its OS version, in the order the core lists them", async () => {
  mount();
  await screen.findByRole("region", { name: "iOS 26.5" });
  expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["iOS 26.5", "iOS 18.6", "Android API 36", "Android API 34"]);
  expect(screen.getAllByRole("button", { name: /^(iPad|iPhone|Pixel)/ }).map((row) => row.textContent)).toEqual(["iPhone 17", "iPad ProRunning", "iPhone 16", "Pixel_9Running", "Pixel_8"]);
});

it("boots a shut-down device chosen in the picker and turns the tab into that device", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "iPhone 17" }));
  await waitFor(() => expect(called("devices.boot")).toEqual([{ deviceId: "iPhone 17" }]));
  expect(currentPage(activeTab(usePanelSessions.getState().sessions[scope]!))).toEqual({ kind: "device", deviceId: "iPhone 17", name: "iPhone 17" });
});

it("opens a running device without booting it, and starts or shuts down from a row's action", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Shut down Pixel_9" }));
  fireEvent.click(screen.getByRole("button", { name: "Start Pixel_8" }));
  await waitFor(() => expect(called("devices.shutdown")).toEqual([{ deviceId: "Pixel_9" }]));
  expect(called("devices.boot")).toEqual([{ deviceId: "Pixel_8" }]);
  fireEvent.click(screen.getByRole("button", { name: /^iPad Pro/ }));
  expect(called("devices.boot")).toHaveLength(1);
  expect(currentPage(activeTab(usePanelSessions.getState().sessions[scope]!))).toMatchObject({ deviceId: "iPad Pro" });
});

it("shows a device tab's screen: a shut-down device offers Start", async () => {
  mount({ kind: "device", deviceId: "iPhone 17", name: "iPhone 17" });
  fireEvent.click(await screen.findByRole("button", { name: "Start" }));
  await waitFor(() => expect(called("devices.boot")).toEqual([{ deviceId: "iPhone 17" }]));
  expect(screen.getByRole("button", { name: "Home" }).hasAttribute("disabled")).toBe(true);
});

it("keeps a started device starting until the list says it runs, never flashing back to Start", async () => {
  mount({ kind: "device", deviceId: "iPhone 17", name: "iPhone 17" });
  fireEvent.click(await screen.findByRole("button", { name: "Start" }));
  await waitFor(() => expect(useDeviceOperations.getState().operations["iPhone 17"]).toBeUndefined());
  const boot = calls.findIndex((call) => call.method === "devices.boot");
  const listAfterBoot = calls.slice(boot + 1).find((call) => call.method === "devices.list");
  expect(listAfterBoot?.operations["iPhone 17"]).toEqual({ kind: "booting" });
  expect(screen.getByText("Starting")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
});

it("explains a running emulator whose video this Mac cannot serve, without streaming it", async () => {
  status.platforms = [baseStatus.platforms[0]!, { platform: "android", available: true, reason: null, video: { available: false, reason: "Android video needs ffmpeg with libx264." } }];
  mount({ kind: "device", deviceId: "Pixel_9", name: "Pixel 9" });
  expect(await screen.findByText("Android video needs ffmpeg with libx264.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Shut down" })).toBeTruthy();
});

it("says so when a device tab's device is gone from this Mac", async () => {
  mount({ kind: "device", deviceId: "Deleted", name: "Old phone" });
  expect(await screen.findByText("This device is no longer on this Mac.")).toBeTruthy();
  expect(screen.getByText("Old phone")).toBeTruthy();
});
