import type { AllowanceWindow } from "@openorc/protocol";

export function allowanceState(window: AllowanceWindow, now: number) {
  const expired = window.resetsAt !== null && window.resetsAt <= now;
  return { expired, stale: expired || now - window.observedAt >= 5 * 60_000 };
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
