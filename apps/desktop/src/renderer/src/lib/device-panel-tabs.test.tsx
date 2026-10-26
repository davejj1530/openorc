import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { CorePush } from "@openorc/protocol";
import { pageLabel } from "../components/panel-tools";
import { activeTab, currentPage, newPanelSession, usePanelSessions, type DevicePage, type PanelPage } from "./panel-tabs";
import { toolPage } from "./panel-workspace";
import { core } from "./rpc";

const scope = "thread:one";
const terminal: PanelPage = { kind: "tool", tool: "terminal" };
const iphone: DevicePage = { kind: "device", deviceId: "UDID-1", name: "iPhone 17" };
const pixel: DevicePage = { kind: "device", deviceId: "Pixel_9", name: "Pixel 9" };
const session = (key = scope) => usePanelSessions.getState().sessions[key] ?? newPanelSession(key);
const actions = () => usePanelSessions.getState();
const pages = (key = scope) => session(key).tabs.map((tab) => currentPage(tab));

const corePort = { onmessage: null as ((event: MessageEvent) => void) | null, start: vi.fn(), postMessage: vi.fn() };
const push = (data: Extract<CorePush, { type: "device.panel" }>) => corePort.onmessage?.(new MessageEvent("message", { data }));

beforeAll(() => {
  Object.defineProperty(window, "openorc", { configurable: true, value: { connectBridge: vi.fn() } });
  core.connect();
  window.dispatchEvent(new MessageEvent("message", { data: "openorc:port", source: window, ports: [corePort as unknown as MessagePort] }));
});

beforeEach(() => {
  localStorage.clear();
  usePanelSessions.setState({ sessions: {} });
});

it("opens Device as a picker tab and turns that tab into the device chosen there", () => {
  actions().navigate(scope, toolPage("device"));
  expect(pageLabel(currentPage(activeTab(session())))).toBe("Device");
  actions().pickDevice(scope, session().activeId, iphone);
  expect(pages()).toEqual([iphone]);
  expect(pageLabel(currentPage(activeTab(session())))).toBe("iPhone 17");
});

it("selects the tab already showing a device instead of showing it twice", () => {
  actions().open(scope, iphone);
  const first = session().activeId;
  actions().add(scope);
  actions().navigate(scope, toolPage("device"));
  actions().pickDevice(scope, session().activeId, iphone);
  expect(session().activeId).toBe(first);
  expect(pages()).toEqual([iphone, toolPage("device")]);
});

it("adds an agent's device to a conversation that is not on screen, once, with its latest name", () => {
  actions().open(scope, terminal);
  push({ type: "device.panel", surface: "thread:elsewhere", deviceId: "UDID-1", name: "iPhone", action: "open" });
  push({ type: "device.panel", surface: "thread:elsewhere", deviceId: "UDID-1", name: "iPhone 17", action: "open" });
  expect(pages("thread:elsewhere")).toEqual([iphone]);
  expect(currentPage(activeTab(session("thread:elsewhere")))).toEqual(iphone);
  push({ type: "device.panel", surface: "thread:elsewhere", deviceId: "Pixel_9", name: "Pixel 9", action: "open" });
  expect(pages("thread:elsewhere")).toEqual([iphone, pixel]);
  expect(pages()).toEqual([terminal]);
});

it("drops only the closed device's tabs, and creates nothing for a conversation without tabs", () => {
  actions().open(scope, terminal);
  actions().open(scope, iphone);
  actions().open(scope, pixel);
  actions().select(scope, session().tabs[1]!.id);
  push({ type: "device.panel", surface: scope, deviceId: "UDID-1", name: "iPhone 17", action: "close" });
  expect(pages()).toEqual([terminal, pixel]);
  expect(currentPage(activeTab(session()))).toEqual(terminal);
  push({ type: "device.panel", surface: "thread:none", deviceId: "UDID-1", name: "iPhone 17", action: "close" });
  expect(usePanelSessions.getState().sessions["thread:none"]).toBeUndefined();
});

it("keeps a closed device tab closed after the window reloads", async () => {
  actions().open(scope, terminal);
  actions().open(scope, iphone);
  actions().close(scope, session().activeId);
  const saved = localStorage.getItem("openorc.panel-sessions") ?? "";
  usePanelSessions.setState({ sessions: {} });
  localStorage.setItem("openorc.panel-sessions", saved);
  await usePanelSessions.persist.rehydrate();
  expect(pages()).toEqual([terminal]);
});
