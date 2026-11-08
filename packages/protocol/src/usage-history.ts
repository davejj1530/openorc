import { z } from "zod";
import { HarnessId } from "./harness.js";

/** Bucket edges come from the viewer's calendar, including daylight-saving changes. */
export const UsageHistoryParams = z
  .object({
    boundaries: z.array(z.number().int().nonnegative()).min(2).max(97),
    agent: HarnessId.optional(),
  })
  .strict()
  .refine(
    ({ boundaries }) => boundaries.every((value, index) => index === 0 || value > boundaries[index - 1]!) && boundaries.at(-1)! - boundaries[0]! <= 94 * 86_400_000,
    "Usage buckets must increase and cover at most 94 days.",
  );

export interface UsageTotals {
  /** API-equivalent estimate from provider costs or recorded tokens and model prices. Null means pricing is unavailable. */
  costUsd: number | null;
  /** Uncached input, normalized across agents. */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  sessions: number;
  unpricedSessions: number;
  unreportedTokenSessions: number;
}

export interface UsageAgentTotal extends UsageTotals {
  agent: HarnessId;
}
export interface UsageModelTotal extends UsageAgentTotal {
  model: string | null;
}
export interface UsageHistory {
  total: UsageTotals;
  agents: UsageAgentTotal[];
  models: UsageModelTotal[];
  buckets: { start: number; total: UsageTotals; agents: UsageAgentTotal[] }[];
}
