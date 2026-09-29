import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenOrcApi } from "../../../shared/types";

/** The overlay Chromium reports on Linux: the header area its window controls leave free. */
class FakeOverlay extends EventTarget {
  visible = true;
  free = { left: 0, right: 1167 };
  getTitlebarAreaRect(): DOMRect {
    return { x: this.free.left, left: this.free.left, right: this.free.right, width: this.free.right - this.free.left, y: 0, top: 0, height: 52, bottom: 52 } as DOMRect;
  }
  move(free: { left: number; right: number }, visible = true): void {
    this.free = free;
    this.visible = visible;
    this.dispatchEvent(new Event("geometrychange"));
  }
}

let overlay: FakeOverlay;
const style = () => document.documentElement.style;

/** window.ts reads the platform when it loads, so each case imports it afresh. */
async function load(platform: string) {
  window.openorc = { platform, syncWindowChrome: async () => 1, isFullscreen: async () => false, onFullscreen: () => () => {} } as unknown as OpenOrcApi;
  vi.resetModules();
  const module = await import("./window");
  module.installWindowState();
  const hooks = renderHook(() => ({ left: module.useTrafficLights(), right: module.useWindowsControls() }));
  return { ...module, hooks };
}

beforeEach(() => {
  overlay = new FakeOverlay();
  Object.defineProperty(navigator, "windowControlsOverlay", { value: overlay, configurable: true });
  Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
});
afterEach(() => {
  style().removeProperty("--window-controls-left");
  style().removeProperty("--window-controls-right");
});

it("clears Linux's window controls at whichever end the desktop puts them", async () => {
  const { hooks } = await load("linux");
  expect(hooks.result.current).toEqual({ left: false, right: true });
  expect(style().getPropertyValue("--window-controls-right")).toBe("121px");
  expect(style().getPropertyValue("--window-controls-left")).toBe("8px");

  act(() => overlay.move({ left: 113, right: 1280 }));
  expect(hooks.result.current).toEqual({ left: true, right: false });
  expect(style().getPropertyValue("--window-controls-left")).toBe("121px");
  expect(style().getPropertyValue("--window-controls-right")).toBe("8px");

  act(() => overlay.move({ left: 40, right: 1200 }));
  expect(hooks.result.current).toEqual({ left: true, right: true });
});

it("gives the room back when Linux hides its controls, as in fullscreen", async () => {
  const { hooks } = await load("linux");
  act(() => overlay.move({ left: 0, right: 1171 }, false));
  expect(hooks.result.current).toEqual({ left: false, right: false });
  expect(style().getPropertyValue("--window-controls-right")).toBe("8px");
});

it("keeps macOS and Windows on their fixed native clearances", async () => {
  const mac = await load("darwin");
  expect(mac.hooks.result.current).toEqual({ left: true, right: false });
  const windows = await load("win32");
  expect(windows.hooks.result.current).toEqual({ left: false, right: true });
  act(() => overlay.move({ left: 113, right: 1280 }));
  expect(windows.hooks.result.current).toEqual({ left: false, right: true });
  expect(style().getPropertyValue("--window-controls-left")).toBe("");
  expect(style().getPropertyValue("--window-controls-right")).toBe("");
});
