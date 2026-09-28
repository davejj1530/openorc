import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  theme: { themeSource: "system", prefersReducedTransparency: false, shouldUseDarkColors: true },
  handle: vi.fn(),
  fromWebContents: vi.fn(),
  release: vi.fn(() => "10.0.22621"),
}));
vi.mock("electron", () => ({ nativeTheme: fake.theme, ipcMain: { handle: fake.handle }, BrowserWindow: { fromWebContents: fake.fromWebContents } }));
vi.mock("node:os", () => ({ release: fake.release }));
import { applyWindowAppearance, installWindowAppearance } from "./window-appearance";

const win = { setVibrancy: vi.fn(), setBackgroundMaterial: vi.fn(), setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn() };
const appearance = { theme: "dark", transparent: true, background: "#1c1916" } as const;
const apply = () => applyWindowAppearance(win as unknown as BrowserWindow, appearance);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  fake.theme.prefersReducedTransparency = false;
});
afterEach(() => vi.restoreAllMocks());

it("turns native blur on and restores the palette ground when disabled", () => {
  expect(apply()).toEqual({ supported: true, enabled: true, reducedTransparency: false });
  expect(win.setVibrancy).toHaveBeenLastCalledWith("under-window");
  expect(win.setBackgroundColor).toHaveBeenLastCalledWith("#00000000");
  applyWindowAppearance(win as unknown as BrowserWindow, { ...appearance, transparent: false });
  expect(win.setVibrancy).toHaveBeenLastCalledWith(null);
  expect(win.setBackgroundColor).toHaveBeenLastCalledWith(appearance.background);
});

it("honors Reduce Transparency without losing the requested appearance", () => {
  fake.theme.prefersReducedTransparency = true;
  expect(apply()).toEqual({ supported: true, enabled: false, reducedTransparency: true });
  expect(fake.theme.themeSource).toBe("dark");
  expect(win.setBackgroundColor).toHaveBeenLastCalledWith(appearance.background);
});

it("uses acrylic on supported Windows and an opaque fallback on older Windows and Linux", () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  expect(apply().enabled).toBe(true);
  expect(win.setBackgroundMaterial).toHaveBeenLastCalledWith("acrylic");
  fake.release.mockReturnValueOnce("10.0.22000");
  expect(apply().supported).toBe(false);
  expect(win.setBackgroundColor).toHaveBeenLastCalledWith(appearance.background);
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  expect(apply().supported).toBe(false);
});

it("accepts only the app's top frame and validates appearance messages", () => {
  installWindowAppearance((url) => url === "https://app.test/");
  const handler = fake.handle.mock.calls[0]![1] as (event: IpcMainInvokeEvent, value: unknown) => unknown;
  const frame = { url: "https://app.test/" };
  const event = { senderFrame: frame, sender: { mainFrame: frame } } as unknown as IpcMainInvokeEvent;
  fake.fromWebContents.mockReturnValue(win);
  expect(handler(event, appearance)).toMatchObject({ enabled: true });
  expect(() => handler({ ...event, senderFrame: { url: frame.url } } as IpcMainInvokeEvent, appearance)).toThrow("Only the app window");
  frame.url = "https://untrusted.test/";
  expect(() => handler(event, appearance)).toThrow("Only the app window");
  frame.url = "https://app.test/";
  for (const value of [null, {}, { ...appearance, transparent: "true" }, { ...appearance, background: "red" }, { ...appearance, theme: "invalid" }]) {
    expect(() => handler(event, value)).toThrow("Invalid window appearance");
  }
});
