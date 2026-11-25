import { percentLeft, sessionWindow, weeklyWindow, type AllowanceWindow, type HarnessId, type ProviderCredit } from "@openorc/protocol";

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

export function creditBalanceLabel(credit: Pick<ProviderCredit, "unlimited" | "balance" | "currency">): string {
  if (credit.unlimited) return "Unlimited";
  const balance = credit.balance?.trim() ? Number(credit.balance) : NaN;
  if (!Number.isFinite(balance)) return "Balance unavailable";
  if (credit.currency) return balance.toLocaleString(undefined, { style: "currency", currency: credit.currency });
  return `${balance.toLocaleString(undefined, { maximumFractionDigits: 2 })} credits`;
}

/**
 * What a model pill's meter shows and says. `left` is the share to fill its disc with, 0 to 100; null where the
 * account has nothing to measure, and the meter is a plain glyph. `low` turns it amber.
 */
export interface UsageMeter {
  left: number | null;
  /** The meter in a few words, its tooltip on a pointer. */
  words: string;
  /** The words with the account's name, as a screen reader says the meter. */
  label: string;
  low: boolean;
}

type MeterAccount = { provider: HarnessId; name: string };
type MeterReport = { windows: AllowanceWindow[]; credits?: readonly ProviderCredit[] };

/**
 * The limits an account's meter measures among those it reports: Antigravity exposes Gemini to OpenOrc, though its CLI
 * also reports a separate Claude and GPT pool, and fx is measured by its first pool of models.
 */
export function meteredWindows(provider: HarnessId, windows: AllowanceWindow[]): AllowanceWindow[] {
  if (provider === "antigravity") return windows.filter((window) => window.id.startsWith("gemini-"));
  return provider === "fx" ? windows.filter((window) => window.group === windows[0]?.group) : windows;
}

/** The week's share left. */
function weekMeter(account: MeterAccount, left: number): UsageMeter {
  const shown = Math.round(left);
  return { left, words: `${shown}% left this week`, label: `${account.name}: ${shown}% left this week`, low: shown <= 10 };
}

/** fx's own budget: its first pool's week, else its short limit, else whichever it reports; with none, its balance. */
function fxMeter(account: MeterAccount, primary: AllowanceWindow[], credits: readonly ProviderCredit[]): UsageMeter | null {
  const window = weeklyWindow(primary) ?? sessionWindow(primary) ?? primary.find((each) => percentLeft(each) !== null);
  if (window) {
    const left = percentLeft(window)!;
    const words = `${Math.round(left)}% left · ${window.label}`;
    return { left, words, label: `${account.name}: ${words}`, low: left <= 10 };
  }
  const credit = credits.find((each) => each.unlimited || each.balance !== null);
  if (!credit) return null;
  const words = `${credit.label}: ${creditBalanceLabel(credit)}`;
  return { left: null, words, label: `fx: ${words}`, low: !credit.unlimited && Number(credit.balance) <= 0 };
}

/**
 * The meter for an account's report: the week's share left; for fx its own budget or balance; and for an account with
 * no weekly limit a plain glyph once its conversation has a `cost` to open on. Null where there is nothing to show.
 */
export function usageMeter(account: MeterAccount, report: MeterReport | undefined, cost: number | null): UsageMeter | null {
  const windows = report ? meteredWindows(account.provider, report.windows) : null;
  if (account.provider === "fx") return fxMeter(account, windows ?? [], report?.credits ?? []) ?? noLimitMeter(account, cost);
  const week = windows ? weeklyWindow(windows) : null;
  const left = week ? percentLeft(week) : null;
  return left === null ? noLimitMeter(account, cost) : weekMeter(account, left);
}

/** An account with no weekly limit has nothing to measure: a plain glyph, opening on what the conversation has cost. */
function noLimitMeter(account: MeterAccount, cost: number | null): UsageMeter | null {
  return cost === null ? null : { left: null, words: "No weekly limit", label: `${account.name}: no weekly limit`, low: false };
}
