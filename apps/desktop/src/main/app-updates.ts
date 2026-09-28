import type { AppUpdater } from "electron-updater";
import type { EventEmitter } from "node:events";

export type UpdateState =
  | { phase: "disabled"; reason: string }
  | { phase: "idle" | "checking" | "current" }
  | { phase: "available" | "downloading" | "ready"; version: string; percent?: number; error?: string }
  | { phase: "installing"; version: string }
  | { phase: "error"; message: string }
  | { phase: "install-error"; message: string };

type Updater = Pick<AppUpdater, "checkForUpdates" | "downloadUpdate" | "quitAndInstall" | "autoDownload" | "autoInstallOnAppQuit" | "allowPrerelease" | "allowDowngrade" | "requestHeaders"> &
  Pick<EventEmitter, "on" | "removeListener">;
const detail = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * GitHub answers 404 for the latest release until a stable one exists, and electron-updater reports that as a failed
 * check. Stable builds are the only ones offered, so for an installed build it means nothing newer is published yet.
 * The same error code also wraps network failures; only the 404 is treated as "nothing to install".
 */
function noStableRelease(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return code === "ERR_UPDATER_NO_PUBLISHED_VERSIONS" || (code === "ERR_UPDATER_LATEST_VERSION_NOT_FOUND" && /HttpError: 404\b/.test(error.message));
}

/** Owns update policy. Only an explicit install may drain the core and hand control to the installer. */
export class AppUpdates {
  private current: UpdateState;
  private operation: Promise<void> | null = null;
  private listeners = new Set<(state: UpdateState) => void>();
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    private readonly updater: Updater,
    disabledReason: string | null,
    private readonly prepareInstall: () => Promise<string | null>,
  ) {
    this.current = disabledReason ? { phase: "disabled", reason: disabledReason } : { phase: "idle" };
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    // electron-updater sends a random ID, which it keeps in the profile's .updaterId, with every request so a release
    // can reach a percentage of installs first. OpenOrc releases to everyone at once, so every install sends it empty.
    updater.requestHeaders = { ...updater.requestHeaders, "x-user-staging-id": "" };
    updater.on("error", this.onError);
    updater.on("download-progress", this.onProgress);
  }

  get state(): UpdateState {
    return this.current;
  }

  subscribe(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(state: UpdateState): void {
    this.current = state;
    for (const listener of this.listeners) listener(state);
  }

  private readonly onError = (error: Error): void => {
    // Check/download promise rejections retain the correct retry action below.
    // Native installer errors can arrive after quitAndInstall has returned.
    if (this.current.phase === "installing") this.set({ phase: "install-error", message: detail(error) });
  };

  private readonly onProgress = (progress: { percent: number }): void => {
    if (this.current.phase === "downloading") this.set({ ...this.current, percent: Math.max(0, Math.min(100, progress.percent)) });
  };

  private run(work: () => Promise<void>): Promise<void> {
    if (this.operation) return this.operation;
    // Reserve the operation before invoking anything that can notify subscribers.
    const pending = Promise.resolve().then(work);
    this.operation = pending.finally(() => {
      this.operation = null;
    });
    return this.operation;
  }

  check(): Promise<void> {
    if (!["idle", "current", "error", "checking"].includes(this.current.phase)) return this.operation ?? Promise.resolve();
    return this.run(async () => {
      this.set({ phase: "checking" });
      try {
        const result = await this.updater.checkForUpdates();
        if (!result) throw new Error("Updates are unavailable in this build.");
        this.set(result.isUpdateAvailable ? { phase: "available", version: result.updateInfo.version } : { phase: "current" });
      } catch (error) {
        this.set(noStableRelease(error) ? { phase: "current" } : { phase: "error", message: detail(error) });
      }
    });
  }

  download(): Promise<void> {
    const state = this.current;
    if (state.phase !== "available") return this.operation ?? Promise.resolve();
    return this.run(async () => {
      this.set({ phase: "downloading", version: state.version, percent: 0 });
      try {
        await this.updater.downloadUpdate();
        this.set({ phase: "ready", version: state.version });
      } catch (error) {
        this.set({ phase: "available", version: state.version, error: detail(error) });
      }
    });
  }

  install(): Promise<void> {
    const state = this.current;
    if (state.phase !== "ready") return this.operation ?? Promise.resolve();
    return this.run(async () => {
      this.set({ phase: "installing", version: state.version });
      try {
        const blocked = await this.prepareInstall();
        if (blocked) {
          this.set({ phase: "ready", version: state.version, error: blocked });
          return;
        }
        // If the native updater failed during preparation, never start its installer.
        if (this.current.phase === "installing") this.updater.quitAndInstall(false, true);
      } catch (error) {
        // The core may already have closed. Do not admit new work or retry a half-finished handoff.
        this.set({ phase: "install-error", message: detail(error) });
      }
    });
  }

  /** While on, checks shortly after this call and every six hours. A check never downloads or installs. */
  setAutomaticChecks(on: boolean): void {
    this.stopChecks();
    if (!on || this.current.phase === "disabled") return;
    this.timers.push(setTimeout(() => void this.check(), 30_000));
    this.timers.push(setInterval(() => void this.check(), 6 * 60 * 60 * 1000));
    for (const timer of this.timers) timer.unref();
  }

  private stopChecks(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  dispose(): void {
    this.stopChecks();
    this.updater.removeListener("error", this.onError);
    this.updater.removeListener("download-progress", this.onProgress);
    this.listeners.clear();
  }
}
