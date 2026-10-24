import type { HarnessId } from "./harness.js";

/** Sanitized provider reports. Null always means unavailable, never zero. */
export interface AllowanceWindow {
  id: string;
  label: string;
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
  /** "codex", or "claude:" and the Claude account's id: stable from one read to the next. */
  id: string;
  provider: "codex" | "claude";
  /** "Codex" or "Claude", followed by the account's own name when the Mac has more than one Claude account on. */
  name: string;
  plan: string | null;
  status: ProviderUsage["status"];
  /** Labels name the window alone ("5-hour window"); the card already names the provider and the plan. */
  windows: AllowanceWindow[];
  refreshedAt: number | null;
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
