import type { UsageTotals } from "@openorc/protocol";

type Price = { input: number; cached: number; output: number; write?: number; fast?: number; long?: boolean; fastLong?: boolean };

// USD per million tokens, verified 2026-11-09. Keep exact model IDs: an unknown model has no inferred rate.
// https://developers.openai.com/api/docs/pricing
// Retired Codex rates: https://developers.openai.com/api/docs/models/<model>
const prices = new Map<string, Price>([
  ["gpt-6-astra", { input: 10, cached: 1, output: 50, write: 12.5, fast: 2, long: true, fastLong: true }],
  ["gpt-6.1-sol", { input: 2, cached: 0.1, output: 10, write: 2.5, fast: 2, long: true, fastLong: true }],
  ["gpt-6.1-terra", { input: 1, cached: 0.05, output: 5, write: 1.25, fast: 2, long: true, fastLong: true }],
  ["gpt-6-luna", { input: 0.1, cached: 0.01, output: 0.5, write: 0.125, fast: 2, long: true, fastLong: true }],
  ["gpt-6-sol", { input: 2, cached: 0.2, output: 10, write: 2.5, fast: 2, long: true, fastLong: true }],
  ["gpt-5.6-sol", { input: 4, cached: 0.4, output: 20, write: 5, fast: 2, long: true, fastLong: true }],
  ["gpt-5.6-terra", { input: 2, cached: 0.2, output: 12, write: 2.5, fast: 2, long: true, fastLong: true }],
  ["gpt-5.6-luna", { input: 0.2, cached: 0.02, output: 1.2, write: 0.25, fast: 2, long: true, fastLong: true }],
  ["gpt-5.5", { input: 5, cached: 0.5, output: 30, fast: 2.5, long: true }],
  ["gpt-5.4", { input: 2.5, cached: 0.25, output: 15, fast: 2, long: true }],
  ["gpt-5.4-mini", { input: 0.75, cached: 0.075, output: 4.5, fast: 2 }],
  ["gpt-5.4-nano", { input: 0.2, cached: 0.02, output: 1.25 }],
  ["gpt-5.3-codex", { input: 1.75, cached: 0.175, output: 14, fast: 2 }],
  ["gpt-5.2-codex", { input: 1.75, cached: 0.175, output: 14 }],
  ["gpt-5.2", { input: 1.75, cached: 0.175, output: 14, fast: 2 }],
  ["gpt-5.1-codex-max", { input: 1.25, cached: 0.125, output: 10 }],
  ["gpt-5.1-codex", { input: 1.25, cached: 0.125, output: 10 }],
  ["gpt-5.1-codex-mini", { input: 0.25, cached: 0.025, output: 2 }],
  ["gpt-5-codex", { input: 1.25, cached: 0.125, output: 10 }],
  ["gpt-5.1", { input: 1.25, cached: 0.125, output: 10, fast: 2 }],
  ["gpt-5", { input: 1.25, cached: 0.125, output: 10, fast: 2 }],
  ["codex-mini-latest", { input: 1.5, cached: 0.375, output: 6 }],
]);

/** Input is already uncached; price deltas, never the cumulative session counters. */
export function estimateCodexCost({
  model,
  fastMode,
  tokens,
  requestInputTokens = 0,
}: {
  model: string | null;
  fastMode: boolean;
  tokens: Pick<UsageTotals, "inputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "outputTokens">;
  requestInputTokens?: number;
}): number | null {
  const id = model?.replace(/^openai\//, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
  const price = id ? prices.get(id) : undefined;
  if (!price || (fastMode && price.fast === undefined)) return null;
  const long = price.long && requestInputTokens > 272_000;
  if (long && fastMode && !price.fastLong) return null;
  const inputMultiplier = long ? 2 : 1;
  const outputMultiplier = long ? 1.5 : 1;
  const speed = fastMode ? (price.fast ?? 1) : 1;
  // Codex does not distinguish cache lifetimes; use the default 30-minute write rate.
  const inputCost = tokens.inputTokens * price.input + tokens.cacheReadTokens * price.cached + tokens.cacheWriteTokens * (price.write ?? price.input);
  return (speed * (inputCost * inputMultiplier + tokens.outputTokens * price.output * outputMultiplier)) / 1_000_000;
}
