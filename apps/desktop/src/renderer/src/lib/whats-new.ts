import { whatsNewDue } from "@openorc/client";
import { create } from "zustand";
import { readOnboardingState } from "./onboarding";

/**
 * Whether a profile is due the steps on what an update brought. They come once, after the update to the release that
 * brings OpenOrc Cloud: to a profile that ran an earlier version, not to a fresh install, whose onboarding comes first.
 */

/** The first release with OpenOrc Cloud: the one after the last release without it. */
export const CLOUD_RELEASE = "0.1.0-beta.35";

const STORAGE_KEY = "openorc.whatsNew";

/** The version this profile last settled the steps for. */
export function readWhatsNewSeen(): string | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    return value && typeof value === "object" && "seen" in value && typeof value.seen === "string" ? value.seen : null;
  } catch {
    return null;
  }
}

/** Settles the steps for `version`: closed, or not due. */
export function writeWhatsNewSeen(version: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ seen: version }));
  } catch {
    // A profile that cannot save sees the steps again next time, which is all it costs.
  }
}

interface WhatsNewState {
  /** The version whose steps are due in this window, until they are closed. */
  due: string | null;
  /** Decides once, at start, for the version running; a profile they are not due to is settled at once. */
  settle(running: string): void;
  /** Closed for good: the profile is settled for the version. */
  close(): void;
}

export const useWhatsNew = create<WhatsNewState>((set, get) => ({
  due: null,
  settle(running) {
    const onboarding = readOnboardingState();
    const onboarded = onboarding.step === "done" || onboarding.completedAt !== null;
    if (whatsNewDue({ release: CLOUD_RELEASE, running, seen: readWhatsNewSeen(), onboarded })) set({ due: running });
    else writeWhatsNewSeen(running);
  },
  close() {
    const due = get().due;
    if (due) writeWhatsNewSeen(due);
    set({ due: null });
  },
}));
