import type { AllowanceWindow } from "@openorc/protocol";

export function allowanceState(window: AllowanceWindow, now: number) {
  const expired = window.resetsAt !== null && window.resetsAt <= now;
  return { expired, stale: expired || now - window.observedAt >= 5 * 60_000 };
}

/** The share of a limit that is left: as reported, or from the share used. Null when neither is known. */
export function percentLeft(window: AllowanceWindow): number | null {
  if (window.remainingPercent !== null) return window.remainingPercent;
  return window.usedPercent === null ? null : 100 - window.usedPercent;
}

const WEEK = /7-day|week/i;

/** A week-long limit that covers one model only, such as Claude's "7-day window · Opus". */
const singleModel = (window: AllowanceWindow) => /^(model_scoped:|seven_day_)/.test(window.id) || /7-day window · (?!all models)/.test(window.label);

/**
 * The account's week-long limit, for the sidebar's usage chip: the account-wide one when a provider also reports
 * limits for single models, else the first that runs a week.
 */
export function weeklyWindow(windows: AllowanceWindow[]): AllowanceWindow | null {
  const weekly = windows.filter((window) => (WEEK.test(window.label) || WEEK.test(window.id)) && percentLeft(window) !== null);
  return weekly.find((window) => !singleModel(window)) ?? weekly[0] ?? null;
}

export function formatUsageTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(timestamp);
}

/** Relative resets keep the overview readable; the full device-local date is available on hover. */
export function usageResetLabel(timestamp: number | null, now: number): string {
  if (timestamp === null) return "Reset time unavailable";
  if (timestamp <= now) return "Reset passed · refresh usage";
  const minutes = Math.ceil((timestamp - now) / 60_000);
  if (minutes < 60) return `Resets in ${minutes}m`;
  if (minutes < 24 * 60) return `Resets in ${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  return `Resets ${new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(timestamp)}`;
}
