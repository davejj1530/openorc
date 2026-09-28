import type { AllowanceWindow } from "@openorc/protocol";

export function allowanceState(window: AllowanceWindow, now: number) {
  const expired = window.resetsAt !== null && window.resetsAt <= now;
  return { expired, stale: expired || now - window.observedAt >= 5 * 60_000 };
}

export function formatUsageTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(timestamp);
}
