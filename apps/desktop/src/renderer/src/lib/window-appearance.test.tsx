import { beforeEach, expect, it, vi } from "vitest";
import type { OpenOrcApi, WindowAppearanceResult } from "../../../shared/types";

vi.mock("./color", () => ({ toHex: (color: string) => color }));
const sync = vi.fn(async (): Promise<WindowAppearanceResult> => ({ supported: true, enabled: true, reducedTransparency: false }));
import { syncWindowAppearance, useWindowAppearance } from "./window-appearance";
import { useTheme } from "./theme";

beforeEach(() => {
  localStorage.clear();
  sync.mockReset();
  sync.mockResolvedValue({ supported: true, enabled: true, reducedTransparency: false });
  window.openorc = { syncWindowAppearance: sync } as unknown as OpenOrcApi;
  useWindowAppearance.setState({ transparent: false, transparency: 35, supported: false, reducedTransparency: false, failed: false });
  document.documentElement.dataset.transparentShell = "false";
});

it("persists transparency and synchronizes saved changes from another window", async () => {
  expect(useWindowAppearance.getState().setTransparent(true)).toBe(true);
  expect(localStorage.getItem("openorc.transparentShell")).toBe("true");
  await Promise.resolve();
  expect(document.documentElement.dataset.transparentShell).toBe("true");
  localStorage.removeItem("openorc.transparentShell");
  sync.mockResolvedValue({ supported: true, enabled: false, reducedTransparency: false });
  window.dispatchEvent(new StorageEvent("storage", { key: "openorc.transparentShell" }));
  await Promise.resolve();
  expect(useWindowAppearance.getState().transparent).toBe(false);
  expect(document.documentElement.dataset.transparentShell).toBe("false");
});

it("resolves Conductor in both modes and keeps custom colors while changing transparency", () => {
  useTheme.getState().setPreset("conductor");
  useTheme.getState().set("dark");
  useTheme.getState().setColor("--bg", "#302010");
  useWindowAppearance.getState().setTransparent(true);
  expect(sync).toHaveBeenLastCalledWith({ theme: "dark", transparent: true, background: "#302010" });
  useTheme.getState().set("light");
  expect(sync).toHaveBeenLastCalledWith({ theme: "light", transparent: true, background: "#faf8f7" });
  useTheme.getState().set("dark");
  expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#302010");
  expect(localStorage.getItem("openorc.palette")).toBe("conductor");
});

it("keeps the shell opaque on a native failure and ignores stale replies", async () => {
  let finish!: (result: WindowAppearanceResult) => void;
  sync.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  syncWindowAppearance("dark");
  sync.mockRejectedValueOnce(new Error("Native window unavailable"));
  syncWindowAppearance("light");
  await Promise.resolve();
  finish({ supported: true, enabled: true, reducedTransparency: false });
  await Promise.resolve();
  expect(document.documentElement.dataset.transparentShell).toBe("false");
  expect(useWindowAppearance.getState().failed).toBe(true);
});

it("reports unavailable storage while still applying the current session preference", () => {
  const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  expect(useWindowAppearance.getState().setTransparent(true)).toBe(false);
  expect(useWindowAppearance.getState().transparent).toBe(true);
  expect(useWindowAppearance.getState().setTransparency(60)).toBe(false);
  expect(document.documentElement.style.getPropertyValue("--shell-opacity")).toBe("40%");
  save.mockRestore();
});

it("updates tint live without native calls and preserves the amount across toggles and theme changes", () => {
  expect(useWindowAppearance.getState().setTransparency(72)).toBe(true);
  expect(localStorage.getItem("openorc.shellTransparency")).toBe("72");
  expect(document.documentElement.style.getPropertyValue("--shell-opacity")).toBe("28%");
  expect(sync).not.toHaveBeenCalled();
  useWindowAppearance.getState().setTransparent(true);
  useWindowAppearance.getState().setTransparent(false);
  useTheme.getState().set("light");
  useWindowAppearance.getState().setTransparent(true);
  expect(useWindowAppearance.getState().transparency).toBe(72);
  expect(document.documentElement.style.getPropertyValue("--shell-opacity")).toBe("28%");
});

it.each([
  ["80", 80],
  ["100", 100],
  ["0", 0],
  ["120", 100],
  ["-10", 0],
  ["NaN", 35],
  ["", 35],
  [null, 35],
] as const)("restores saved transparency %s safely across windows", (stored, expected) => {
  if (stored !== null) localStorage.setItem("openorc.shellTransparency", stored);
  window.dispatchEvent(new StorageEvent("storage", { key: "openorc.shellTransparency" }));
  expect(useWindowAppearance.getState().transparency).toBe(expected);
  expect(document.documentElement.style.getPropertyValue("--shell-opacity")).toBe(`${100 - expected}%`);
  expect(sync).not.toHaveBeenCalled();
});
