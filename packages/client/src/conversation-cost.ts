import type { Run } from "@openorc/protocol";

/**
 * What a conversation has cost, from the runs it is made of. Each run keeps the latest running total its provider
 * session reported, and a resumed session continues that total, so the conversation's cost is each session's latest
 * total added up. Null when no run reported a cost.
 */
export function conversationCost(runs: readonly Pick<Run, "id" | "externalSessionId" | "usage">[]): number | null {
  const totals = new Map<string, number>();
  for (const run of runs) {
    const cost = run.usage?.costUsd;
    if (cost !== undefined) totals.set(run.externalSessionId ?? run.id, cost);
  }
  if (!totals.size) return null;
  let sum = 0;
  for (const cost of totals.values()) sum += cost;
  return sum;
}

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** "$1.97", "$1,204.50", or "under $0.01" for an amount too small to round to a cent. */
export function formatCost(amount: number): string {
  return amount > 0 && amount < 0.005 ? "under $0.01" : dollars.format(amount);
}
