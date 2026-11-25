import { allowanceState, usageResetLabel } from "@openorc/client";
import type { AllowanceWindow } from "@openorc/protocol";

const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** A time of day as usage states one: when a report was read, or taken. */
export const usageTime = (at: number): string => time.format(at);

/**
 * Whether a limit's reading is out of date: the Mac's once it is older than its rule allows, or its account could not
 * be read (`outdated`). A reading of OpenOrc Cloud's (`turnRead`) comes only from a turn on the account, so it is never
 * out of date by age.
 */
export function limitStale(window: AllowanceWindow, now: number, { outdated, turnRead }: { outdated: boolean; turnRead: boolean }): boolean {
  return outdated || (!turnRead && allowanceState(window, now).stale);
}

/** Under a limit: when it resets; for a reading of OpenOrc Cloud's, when it was taken; out of date, that with why. */
export function resetWords(window: AllowanceWindow, now: number, stale: boolean, turnRead: boolean): string {
  const reported = usageTime(window.observedAt);
  if (stale) return `Out of date · reported ${reported}`;
  return turnRead ? `Reported ${reported}` : usageResetLabel(window.resetsAt, now);
}
