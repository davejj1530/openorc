import type { UpdateSnapshot, UpdateState } from "../shared/app-updates";
import type { AppUpdates } from "./app-updates";
import type { UpdatePreferences } from "./update-preferences";

interface NoticeDelivery {
  foreground(): boolean;
  notify(version: string, reveal: () => void): void;
  reveal(): void;
}

/** One owner for all windows, with per-version dismissal and notification history. */
export class UpdateNotices {
  private dismissed: string | null;
  private notified: string | undefined;
  private hiddenPhase: "downloading" | "install-error" | null = null;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly updates: AppUpdates,
    private readonly preferences: UpdatePreferences,
    private readonly delivery: NoticeDelivery,
    private readonly changed: (snapshot: UpdateSnapshot) => void,
  ) {
    this.dismissed = preferences.dismissedVersion();
    this.notified = preferences.notifiedVersion();
    this.unsubscribe = updates.subscribe((state) => this.refresh(state));
  }

  get snapshot(): UpdateSnapshot {
    const state = this.updates.state;
    return { state, dismissed: this.hiddenPhase === state.phase || ("version" in state && this.dismissed === state.version) };
  }

  dismiss(): UpdateSnapshot {
    const state = this.updates.state;
    if (state.phase === "available" || state.phase === "ready") {
      this.preferences.dismiss(state.version);
      this.dismissed = state.version;
      this.changed(this.snapshot);
    } else if (state.phase === "downloading" || state.phase === "install-error") {
      this.hiddenPhase = state.phase;
      this.changed(this.snapshot);
    }
    return this.snapshot;
  }

  private refresh(state: UpdateState): void {
    if (this.hiddenPhase !== state.phase) this.hiddenPhase = null;
    // Starting a download from the menu also brings its progress back into view.
    if (state.phase === "downloading" && this.dismissed) this.revealNotice();
    this.changed(this.snapshot);
    if (state.phase !== "available" || state.error || this.snapshot.dismissed || this.notified === state.version || this.delivery.foreground()) return;
    this.notified = state.version;
    // A notification or an unwritable preference must never break the updater's state transition.
    try {
      this.preferences.markNotified(state.version);
    } catch (error) {
      console.warn("Could not save update notification history", error);
    }
    try {
      this.delivery.notify(state.version, () => {
        this.revealNotice();
        this.changed(this.snapshot);
        this.delivery.reveal();
      });
    } catch (error) {
      console.warn("Could not show update notification", error);
    }
  }

  private revealNotice(): void {
    this.dismissed = null;
    this.hiddenPhase = null;
    try {
      this.preferences.dismiss(null);
    } catch (error) {
      console.warn("Could not save update notice visibility", error);
    }
  }

  dispose(): void {
    this.unsubscribe();
  }
}
