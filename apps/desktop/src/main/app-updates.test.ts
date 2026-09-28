import { EventEmitter } from "node:events";
import type { AppUpdater, UpdateCheckResult } from "electron-updater";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppUpdates } from "./app-updates";

class FakeUpdater extends EventEmitter {
  requestHeaders: Record<string, string> | null = { "user-agent": "fixture" };
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  allowDowngrade = true;
  checkForUpdates = vi.fn<AppUpdater["checkForUpdates"]>();
  downloadUpdate = vi.fn<AppUpdater["downloadUpdate"]>().mockResolvedValue(["download.zip"]);
  quitAndInstall = vi.fn<AppUpdater["quitAndInstall"]>();
}
const info = { version: "0.2.0", files: [], releaseDate: "2026-09-23T00:00:00Z", path: "app.zip", sha512: "fixture" };
const available: UpdateCheckResult = { isUpdateAvailable: true, updateInfo: info, versionInfo: info };
const instances: AppUpdates[] = [];
function fixture(disabled: string | null = null) {
  const updater = new FakeUpdater();
  updater.checkForUpdates.mockResolvedValue(available);
  const prepare = vi.fn<() => Promise<string | null>>().mockResolvedValue(null);
  const updates = new AppUpdates(updater, disabled, prepare);
  instances.push(updates);
  return { updater, prepare, updates };
}
afterEach(() => {
  for (const updates of instances.splice(0)) updates.dispose();
  vi.useRealTimers();
});

describe("desktop update policy", () => {
  it("never contacts a feed for development or unconfigured builds", async () => {
    vi.useFakeTimers();
    const { updater, updates } = fixture("No release feed");
    updates.setAutomaticChecks(true);
    await updates.check();
    await updates.download();
    await updates.install();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("checks quietly on a schedule without downloading or installing", async () => {
    vi.useFakeTimers();
    const { updater, updates } = fixture();
    expect(updater).toMatchObject({ autoDownload: false, autoInstallOnAppQuit: false, allowPrerelease: false, allowDowngrade: false });
    updater.checkForUpdates.mockResolvedValue({ ...available, isUpdateAvailable: false });
    updates.setAutomaticChecks(true);
    updates.setAutomaticChecks(true);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(updates.state.phase).toBe("current");
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("stops checking on its own once automatic checks are off", async () => {
    vi.useFakeTimers();
    const { updater, updates } = fixture();
    updates.setAutomaticChecks(true);
    updates.setAutomaticChecks(false);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    await updates.check();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("sends no install identifier with update requests", () => {
    const { updater } = fixture();
    expect(updater.requestHeaders).toEqual({ "user-agent": "fixture", "x-user-staging-id": "" });
  });

  it("coalesces checks and downloads, retains progress, and waits for a safe explicit restart", async () => {
    const { updater, prepare, updates } = fixture();
    await Promise.all([updates.check(), updates.check()]);
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    expect(updates.state).toEqual({ phase: "available", version: "0.2.0" });
    let finishDownload!: (paths: string[]) => void;
    updater.downloadUpdate.mockReturnValueOnce(
      new Promise((resolve) => {
        finishDownload = resolve;
      }),
    );
    const first = updates.download();
    const second = updates.download();
    await Promise.resolve();
    updater.emit("download-progress", { percent: 47.2 });
    expect(updates.state).toMatchObject({ phase: "downloading", percent: 47.2 });
    finishDownload(["download.zip"]);
    await Promise.all([first, second]);
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
    expect(updates.state.phase).toBe("ready");
    expect(prepare).not.toHaveBeenCalled();
    await updates.check();
    expect(updates.state.phase).toBe("ready");
    prepare.mockResolvedValueOnce("Agent still running");
    await updates.install();
    expect(updates.state).toMatchObject({ phase: "ready", error: "Agent still running" });
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    let finishCore!: (reason: string | null) => void;
    prepare.mockReturnValueOnce(
      new Promise((resolve) => {
        finishCore = resolve;
      }),
    );
    const install = updates.install();
    const duplicate = updates.install();
    await Promise.resolve();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    finishCore(null);
    await Promise.all([install, duplicate]);
    expect(updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(false, true);
  });

  it("treats a feed with no stable release as up to date, but still reports a failed connection", async () => {
    const failure = (message: string, code: string) => Object.assign(new Error(message), { code });
    const { updater, updates } = fixture();
    updater.checkForUpdates.mockRejectedValueOnce(
      failure(
        "Unable to find latest version on GitHub (https://github.com/o/r/releases/latest), please ensure a production release exists: HttpError: 404 Not Found",
        "ERR_UPDATER_LATEST_VERSION_NOT_FOUND",
      ),
    );
    await updates.check();
    expect(updates.state).toEqual({ phase: "current" });

    updater.checkForUpdates.mockRejectedValueOnce(failure("No published versions on GitHub", "ERR_UPDATER_NO_PUBLISHED_VERSIONS"));
    await updates.check();
    expect(updates.state).toEqual({ phase: "current" });

    const offline = "Unable to find latest version on GitHub (https://github.com/o/r/releases/latest), please ensure a production release exists: Error: getaddrinfo ENOTFOUND github.com";
    updater.checkForUpdates.mockRejectedValueOnce(failure(offline, "ERR_UPDATER_LATEST_VERSION_NOT_FOUND"));
    await updates.check();
    expect(updates.state).toEqual({ phase: "error", message: offline });
  });

  it("retries check and download errors without losing the available version", async () => {
    const { updater, updates } = fixture();
    updater.checkForUpdates.mockRejectedValueOnce(new Error("offline"));
    await updates.check();
    expect(updates.state).toEqual({ phase: "error", message: "offline" });
    await updates.check();
    updater.downloadUpdate.mockRejectedValueOnce(new Error("interrupted"));
    await updates.download();
    expect(updates.state).toMatchObject({ phase: "available", version: "0.2.0", error: "interrupted" });
    await updates.download();
    expect(updates.state.phase).toBe("ready");
  });

  it("never installs after an uncertain shutdown and never retries that handoff", async () => {
    const { updater, prepare, updates } = fixture();
    await updates.check();
    await updates.download();
    prepare.mockRejectedValueOnce(new Error("Core exit not confirmed"));
    await updates.install();
    expect(updates.state.phase).toBe("install-error");
    await updates.install();
    await updates.check();
    expect(prepare).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("reports asynchronous native installer errors without reopening the app to new work", async () => {
    const { updater, updates } = fixture();
    await updates.check();
    await updates.download();
    await updates.install();
    updater.emit("error", new Error("Signature rejected"));
    expect(updates.state).toEqual({ phase: "install-error", message: "Signature rejected" });
    await updates.install();
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
  });
});
