import type { HarnessId } from "./harness.js";

/** Sanitized provider reports. Null always means unavailable, never zero. */
export interface AllowanceWindow {
  id: string;
  label: string;
  /** Model families that share this allowance, when the provider reports separate pools. */
  group?: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: number | null;
  observedAt: number;
  exhausted: boolean;
}

export interface ProviderUsage {
  claudeAccountId?: string;
  provider: HarnessId | "anthropic-api";
  status: "available" | "unavailable" | "disconnected" | "error";
  source: string;
  context: string;
  /** The plan as the provider names it ("Max", "Pro"), when the account reports one. */
  plan: string | null;
  checkedAt: number;
  refreshedAt: number | null;
  message: string | null;
  windows: AllowanceWindow[];
  credits: { label: string; balance: string | null; unlimited: boolean }[];
  accountUrl: string;
  localRuns: number | null;
  resets?: ResetInventory;
}

/**
 * One account's plan limits as a phone draws them, from `providers.limits`: the shares and when they reset, and
 * nothing of who the account belongs to (email, organization), how it signs in (tokens, config folders), what the CLI
 * said, or how to reset it.
 */
export interface PlanLimits {
  /** The provider, or "claude:" and the Claude account's id: stable from one read to the next. */
  id: string;
  provider: "codex" | "claude" | "antigravity";
  /** The provider name, followed by the account's own name when the Mac has more than one Claude account on. */
  name: string;
  plan: string | null;
  status: ProviderUsage["status"];
  /** Labels name the window alone ("5-hour window"); the card already names the provider and the plan. */
  windows: AllowanceWindow[];
  refreshedAt: number | null;
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

const SESSION = /hour|session/i;

/** The account's short rolling limit, such as Claude's and Codex's 5-hour window, for the usage table beside the week. */
export function sessionWindow(windows: AllowanceWindow[]): AllowanceWindow | null {
  const named = (pattern: RegExp, window: AllowanceWindow) => pattern.test(window.label) || pattern.test(window.id);
  return windows.find((window) => named(SESSION, window) && !named(WEEK, window) && percentLeft(window) !== null) ?? null;
}

export interface ResetCredit {
  id: string;
  title: string | null;
  description: string | null;
  expiresAt: number | null;
}

export interface ResetInventory {
  availableCount: number | null;
  credits: ResetCredit[] | null;
  redemption: "available" | "external" | "unavailable";
  /** Opaque snapshot of the account and inventory the user is confirming. */
  confirmationToken?: string;
  pendingAttempt?: { id: string; creditId?: string };
  message?: string;
}

export type ResetOutcome = "reset" | "alreadyRedeemed" | "nothingToReset" | "noCredit" | "unsupported" | "confirmationRequired" | "pending";
export interface ResetResult {
  outcome: ResetOutcome;
  message: string;
  usage: ProviderUsage;
}
