import { UsageHistoryParams, type UsageHistory, type UsageTotals } from "../../packages/protocol/src/usage-history";
import { estimateCodexCost } from "../../packages/db/src/usage-pricing";

const empty = (): UsageTotals => ({ costUsd: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, sessions: 0, unpricedSessions: 0, unreportedTokenSessions: 0 });
function add(sum: UsageTotals, value: UsageTotals): UsageTotals {
  let costUsd = sum.costUsd;
  if (sum.sessions === 0) costUsd = value.costUsd;
  else if (value.costUsd !== null) costUsd = (costUsd ?? 0) + value.costUsd;
  return {
    costUsd,
    inputTokens: sum.inputTokens + value.inputTokens,
    cacheReadTokens: sum.cacheReadTokens + value.cacheReadTokens,
    cacheWriteTokens: sum.cacheWriteTokens + value.cacheWriteTokens,
    outputTokens: sum.outputTokens + value.outputTokens,
    sessions: sum.sessions + value.sessions,
    unpricedSessions: sum.unpricedSessions + value.unpricedSessions,
    unreportedTokenSessions: sum.unreportedTokenSessions + value.unreportedTokenSessions,
  };
}

/** Synthetic accounting for the browser preview, with each bucket containing independent sessions. */
export function designUsage(params: unknown): UsageHistory {
  const { boundaries, agent } = UsageHistoryParams.parse(params);
  const series = [
    { agent: "claude", model: "claude-opus-5-5", rate: 21.4, tokens: 6_840_000, sessions: 3 },
    { agent: "codex", model: "gpt-6.1-sol", rate: null, tokens: 1_240_000, sessions: 12 },
    { agent: "opencode", model: "openai/gpt-6.1-sol", rate: 1.72, tokens: 140_000, sessions: 1 },
  ] satisfies { agent: "claude" | "codex" | "opencode"; model: string; rate: number | null; tokens: number; sessions: number }[];
  const selected = series.filter((row) => !agent || row.agent === agent);
  const buckets = boundaries.slice(0, -1).map((start, index) => {
    const agents = selected.map((row, offset) => {
      const factor = Math.max(0, Math.sin(index * 1.7 + offset * 2) + Math.cos(index * 0.43 + offset) + 1.2);
      const sessions = factor > 0 ? Math.max(1, Math.round(row.sessions * factor)) : 0;
      const count = sessions ? Math.round(row.tokens * factor) : 0;
      const value = {
        agent: row.agent,
        costUsd: row.rate === null ? null : Math.round(row.rate * factor * 100) / 100,
        inputTokens: Math.round(count * 0.12),
        cacheReadTokens: Math.round(count * 0.76),
        cacheWriteTokens: Math.round(count * 0.08),
        outputTokens: Math.round(count * 0.04),
        sessions,
        unpricedSessions: row.rate === null ? sessions : 0,
        unreportedTokenSessions: 0,
      };
      if (row.agent === "codex") {
        value.costUsd = estimateCodexCost({ model: row.model, fastMode: false, tokens: value });
        value.unpricedSessions = value.costUsd === null ? sessions : 0;
      }
      return value;
    });
    return { start, agents, total: agents.reduce(add, empty()) };
  });
  const agents = selected.map((row) => {
    const sum = buckets.flatMap((bucket) => bucket.agents.filter((value) => value.agent === row.agent)).reduce(add, empty());
    return { ...sum, agent: row.agent };
  });
  return { total: agents.reduce(add, empty()), agents, buckets, models: agents.map((row) => ({ ...row, model: selected.find((value) => value.agent === row.agent)?.model ?? null })) };
}
