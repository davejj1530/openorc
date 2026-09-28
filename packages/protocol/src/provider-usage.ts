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
  provider: HarnessId | "anthropic-api";
  status: "available" | "unavailable" | "disconnected" | "error";
  source: string;
  context: string;
  checkedAt: number;
  refreshedAt: number | null;
  message: string | null;
  windows: AllowanceWindow[];
  credits: { label: string; balance: string | null; unlimited: boolean }[];
  accountUrl: string;
  localRuns: number | null;
  resets?: ResetInventory;
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
