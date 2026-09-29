import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppUpdates } from "./app-updates";
import { installUpdateControls } from "./update-ipc";
import { UpdatePreferences } from "./update-preferences";

const native = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  windows: vi.fn(),
  supported: vi.fn(),
  show: vi.fn(),
  close: vi.fn(),
  notices: [] as { options: { title: string; body: string }; click?: () => void }[],
}));
vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: native.windows },
  ipcMain: { handle: (key: string, handler: (...args: unknown[]) => unknown) => native.handlers.set(key, handler), removeHandler: (key: string) => native.handlers.delete(key) },
  Notification: class {
    static isSupported = native.supported;
    record: { options: { title: string; body: string }; click?: () => void };
    constructor(options: { title: string; body: string }) {
      this.record = { options };
      native.notices.push(this.record);
    }
    on(event: string, callback: () => void) {
      if (event === "click") this.record.click = callback;
    }
    show = native.show;
    close = native.close;
  },
}));

let dir: string;
const cleanup: (() => void)[] = [];
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  native.notices.length = 0;
  native.supported.mockReturnValue(true);
  dir = mkdtempSync(join(tmpdir(), "openorc-update-notices-"));
});
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

function windowFixture(focused = false, url = "app://main") {
  return { webContents: { getURL: () => url, send: vi.fn() }, isFocused: () => focused, isVisible: () => true, isMinimized: vi.fn(() => false), restore: vi.fn(), show: vi.fn(), focus: vi.fn() };
}
function fixture(version = "0.2.0", win = windowFixture()) {
  native.windows.mockReturnValue([win]);
  const updater = Object.assign(new EventEmitter(), {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: true,
    allowDowngrade: false,
    requestHeaders: null,
    checkForUpdates: vi.fn(async () => ({
      isUpdateAvailable: true,
      updateInfo: { version, files: [], releaseDate: "2026-09-29", path: "app.zip", sha512: "fixture" },
      versionInfo: { version, files: [], releaseDate: "2026-09-29", path: "app.zip", sha512: "fixture" },
    })),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
  });
  const prepare = vi.fn(async (): Promise<string | null> => null);
  const updates = new AppUpdates(updater, null, prepare);
  const create = vi.fn(() => win as unknown as BrowserWindow);
  const stop = installUpdateControls(updates, join(dir, "updates.json"), (url) => url === "app://main", create);
  const dispose = () => {
    stop();
    updates.dispose();
  };
  cleanup.push(dispose);
  const frame = { url: "app://main" };
  const event = { senderFrame: frame, sender: { mainFrame: frame } };
  const call = (name: string, value?: unknown) => native.handlers.get(`updates:${name}`)!(event, value);
  return { updates, updater, prepare, win, create, dispose, event, call };
}

it("automatically broadcasts availability to app windows and sends one background notification", async () => {
  const f = fixture();
  const second = windowFixture();
  const external = windowFixture(false, "https://example.com");
  native.windows.mockReturnValue([f.win, second, external]);
  await vi.advanceTimersByTimeAsync(30_000);
  const snapshot = { state: { phase: "available", version: "0.2.0" }, dismissed: false };
  expect(f.win.webContents.send).toHaveBeenLastCalledWith("updates:state", snapshot);
  expect(second.webContents.send).toHaveBeenLastCalledWith("updates:state", snapshot);
  expect(external.webContents.send).not.toHaveBeenCalled();
  expect(f.call("getState")).toEqual(snapshot);
  expect(native.show).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);
  expect(native.show).toHaveBeenCalledTimes(1);
  expect(f.updater.downloadUpdate).not.toHaveBeenCalled();
});

it("uses the in-app notice without a desktop notification when any app window is focused", async () => {
  const f = fixture();
  native.windows.mockReturnValue([f.win, windowFixture(true)]);
  await f.updates.check();
  expect(native.show).not.toHaveBeenCalled();
  expect(f.call("getState")).toMatchObject({ state: { phase: "available" }, dismissed: false });
});

it("remembers Later across restarts and settings changes, and prompts for a newer version", async () => {
  const first = fixture();
  await first.updates.check();
  first.call("dismiss", { kind: "later", phase: "available", version: "0.2.0" });
  expect(first.win.webContents.send).toHaveBeenLastCalledWith("updates:state", expect.objectContaining({ dismissed: true }));
  first.call("setAutomaticChecks", false);
  first.dispose();
  const second = fixture();
  await second.updates.check();
  expect(second.call("getState")).toMatchObject({ dismissed: true });
  expect(second.call("settings")).toMatchObject({ automaticChecks: false });
  expect(native.show).toHaveBeenCalledTimes(1);
  second.dispose();
  const third = fixture("0.3.0");
  await third.updates.check();
  expect(third.call("getState")).toMatchObject({ dismissed: false });
  expect(native.show).toHaveBeenCalledTimes(2);
});

it("remembers notification delivery across restarts even without a dismissal", async () => {
  const first = fixture();
  await first.updates.check();
  first.dispose();
  await fixture().updates.check();
  expect(native.show).toHaveBeenCalledTimes(1);
});

it("reveals the update notice and restores a window on notification click without downloading", async () => {
  const f = fixture();
  await f.updates.check();
  f.call("dismiss", { kind: "later", phase: "available", version: "0.2.0" });
  f.win.isMinimized.mockReturnValue(true);
  native.notices[0]!.click!();
  expect(f.win.restore).toHaveBeenCalledOnce();
  expect(f.win.show).toHaveBeenCalledOnce();
  expect(f.win.focus).toHaveBeenCalledOnce();
  expect(f.call("getState")).toMatchObject({ dismissed: false });
  expect(f.updater.downloadUpdate).not.toHaveBeenCalled();
  native.windows.mockReturnValue([]);
  native.notices[0]!.click!();
  expect(f.create).toHaveBeenCalledOnce();
});

it("shares download progress and refusal to restart during work, then permits an explicit safe restart", async () => {
  const f = fixture();
  await f.updates.check();
  f.call("dismiss", { kind: "later", phase: "available", version: "0.2.0" });
  let finish!: () => void;
  f.updater.downloadUpdate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve([]);
      }),
  );
  const pending = f.call("download");
  await Promise.resolve();
  f.updater.emit("download-progress", { percent: 47 });
  expect(f.call("getState")).toMatchObject({ state: { phase: "downloading", percent: 47 }, dismissed: false });
  finish();
  await pending;
  expect(f.call("getState")).toMatchObject({ state: { phase: "ready" } });
  f.prepare.mockResolvedValueOnce("Finish agent work first.");
  await f.call("install");
  expect(f.call("getState")).toMatchObject({ state: { phase: "ready", error: "Finish agent work first." } });
  expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
  await f.call("install");
  expect(f.updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(false, true);
});

it("keeps availability usable if native notification delivery fails or is unsupported", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  native.show.mockImplementationOnce(() => {
    throw new Error("Notifications denied");
  });
  const first = fixture();
  await first.updates.check();
  expect(first.call("getState")).toMatchObject({ state: { phase: "available" } });
  first.dispose();
  native.supported.mockReturnValue(false);
  const second = fixture("0.3.0");
  await second.updates.check();
  expect(second.call("getState")).toMatchObject({ state: { phase: "available" } });
  expect(native.show).toHaveBeenCalledTimes(1);
  warn.mockRestore();
});

it("lets a download be hidden until ready, and lets an unrecoverable install error be dismissed", async () => {
  const f = fixture();
  await f.updates.check();
  let finish!: () => void;
  f.updater.downloadUpdate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve([]);
      }),
  );
  const download = f.call("download");
  await Promise.resolve();
  f.call("dismiss", { kind: "hide", phase: "downloading", version: "0.2.0" });
  f.updater.emit("download-progress", { percent: 50 });
  expect(f.call("getState")).toMatchObject({ state: { phase: "downloading", percent: 50 }, dismissed: true });
  finish();
  await download;
  expect(f.call("getState")).toMatchObject({ state: { phase: "ready" }, dismissed: false });
  f.prepare.mockRejectedValueOnce(new Error("Core shutdown failed"));
  await f.call("install");
  expect(f.call("getState")).toMatchObject({ state: { phase: "install-error" }, dismissed: false });
  f.call("dismiss", { kind: "hide", phase: "install-error" });
  expect(f.call("getState")).toMatchObject({ dismissed: true });
  expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
});

it("rejects every update channel from embedded frames and external pages", () => {
  const f = fixture();
  for (const handler of native.handlers.values()) {
    expect(() => handler({ ...f.event, senderFrame: { url: "app://main" } })).toThrow("Only the app window");
    const frame = { url: "https://example.com" };
    expect(() => handler({ senderFrame: frame, sender: { mainFrame: frame } })).toThrow("Only the app window");
  }
  expect(() => f.call("setAutomaticChecks", "true")).toThrow("on or off");
  for (const request of [undefined, null, { kind: "hide", phase: "ready", version: "0.2.0" }, { kind: "later", phase: "downloading", version: "0.2.0" }, { kind: "later", phase: "available" }]) {
    expect(() => f.call("dismiss", request)).toThrow("Invalid update dismissal");
  }
  f.dispose();
  expect(native.handlers.size).toBe(0);
});

it("preserves notification and dismissal history when changing automatic checks", () => {
  const file = join(dir, "updates.json");
  const preferences = new UpdatePreferences(file);
  preferences.markNotified("0.2.0");
  preferences.dismiss("0.2.0");
  preferences.setAutomaticChecks(false);
  const reloaded = new UpdatePreferences(file);
  expect(reloaded.automaticChecks()).toBe(false);
  expect(reloaded.dismissedVersion()).toBe("0.2.0");
  expect(reloaded.notifiedVersion()).toBe("0.2.0");
});

it("ignores a delayed Hide request after the download becomes ready", async () => {
  const f = fixture();
  await f.updates.check();
  let finish!: () => void;
  f.updater.downloadUpdate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve([]);
      }),
  );
  const download = f.call("download");
  await Promise.resolve();
  // Captured by the renderer while it still shows progress, delivered after main finishes downloading.
  const request = { kind: "hide", phase: "downloading", version: "0.2.0" };
  finish();
  await download;
  f.call("dismiss", request);
  expect(f.call("getState")).toMatchObject({ state: { phase: "ready", version: "0.2.0" }, dismissed: false });
  expect(new UpdatePreferences(join(dir, "updates.json")).dismissedVersion()).toBeNull();
});

it("discovers a newer release on the next scheduled check after Later without restarting", async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(30_000);
  f.call("dismiss", { kind: "later", phase: "available", version: "0.2.0" });
  expect(f.call("getState")).toMatchObject({ state: { phase: "available", version: "0.2.0" }, dismissed: true });
  await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
  expect(f.call("getState")).toMatchObject({ state: { phase: "available", version: "0.2.0" }, dismissed: true });
  expect(native.show).toHaveBeenCalledTimes(1);
  const info = { version: "0.3.0", files: [], releaseDate: "2026-09-29", path: "app.zip", sha512: "fixture" };
  f.updater.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true, updateInfo: info, versionInfo: info });
  await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
  expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(3);
  expect(f.call("getState")).toMatchObject({ state: { phase: "available", version: "0.3.0" }, dismissed: false });
  expect(native.show).toHaveBeenCalledTimes(2);
  expect(f.updater.downloadUpdate).not.toHaveBeenCalled();
  // A slow Later click from another window must not dismiss the newly discovered release.
  f.call("dismiss", { kind: "later", phase: "available", version: "0.2.0" });
  expect(f.call("getState")).toMatchObject({ dismissed: false });
});
