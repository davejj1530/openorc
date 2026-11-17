import { create } from "zustand";
import { readOnboardingState } from "./onboarding";

/**
 * Whether a profile is due the steps on what an update brought. They come once, after the update to the release that
 * brings OpenOrc Cloud: to a profile that ran an earlier version, not to a fresh install, whose onboarding comes first.
 */

/** The first release with OpenOrc Cloud: the one after the last release without it. */
export const CLOUD_RELEASE = "0.1.0-beta.35";

const STORAGE_KEY = "openorc.whatsNew";

type Version = { core: [number, number, number]; beta: number | null };

/** A release version, "1.2.3" or "1.2.3-beta.4"; anything else is none. */
function parse(version: string): Version | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(version);
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], beta: match[4] === undefined ? null : Number(match[4]) };
}

/** Negative when `a` came before `b`, positive after, zero for the same release; a beta comes before its release. */
export function compareVersions(a: string, b: string): number | null {
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i]! - right.core[i]!;
  if (left.beta === right.beta) return 0;
  if (left.beta === null) return 1;
  if (right.beta === null) return -1;
  return left.beta - right.beta;
}

/**
 * `running`: this app's version. `seen`: the last version this profile settled the steps for, or null for a profile
 * that never did, which ran a version from before they existed if it finished onboarding (`onboarded`).
 */
export function whatsNewDue({ running, seen, onboarded }: { running: string; seen: string | null; onboarded: boolean }): boolean {
  const brings = compareVersions(running, CLOUD_RELEASE);
  if (brings === null || brings < 0) return false;
  if (seen === null) return onboarded;
  const before = compareVersions(seen, CLOUD_RELEASE);
  return before !== null && before < 0;
}

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
    if (whatsNewDue({ running, seen: readWhatsNewSeen(), onboarded })) set({ due: running });
    else writeWhatsNewSeen(running);
  },
  close() {
    const due = get().due;
    if (due) writeWhatsNewSeen(due);
    set({ due: null });
  },
}));
