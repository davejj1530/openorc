import { HarnessId, Usage, type RpcParams, type UsageHistory, type UsageTotals } from "@openorc/protocol";
import { z } from "zod";
import type { Db } from "./database.js";
import { estimateCodexCost } from "./usage-pricing.js";

const Report = z.object({
  ts: z.number(),
  agent: HarnessId,
  account: z.string().nullable(),
  session: z.string(),
  model: z.string().nullable(),
  fast: z.number(),
  kind: z.enum(["turn.completed", "usage.updated"]),
  usage: z.string().nullable(),
});

function accumulator() {
  const value: Amounts & { sessions: Set<string>; priced: Set<string>; measured: Set<string> } = {
    costUsd: null,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    sessions: new Set(),
    priced: new Set(),
    measured: new Set(),
  };
  return value;
}
type Accumulator = ReturnType<typeof accumulator>;
type Amounts = Omit<UsageTotals, "sessions" | "unpricedSessions" | "unreportedTokenSessions">;

function add(target: Accumulator, session: string, amounts: Amounts, measured: boolean) {
  target.sessions.add(session);
  if (measured) target.measured.add(session);
  if (amounts.costUsd !== null) {
    target.costUsd = (target.costUsd ?? 0) + amounts.costUsd;
    target.priced.add(session);
  }
  target.inputTokens += amounts.inputTokens;
  target.cacheReadTokens += amounts.cacheReadTokens;
  target.cacheWriteTokens += amounts.cacheWriteTokens;
  target.outputTokens += amounts.outputTokens;
}

function totals(value: Accumulator): UsageTotals {
  return {
    costUsd: value.sessions.size ? value.costUsd : 0,
    inputTokens: value.inputTokens,
    cacheReadTokens: value.cacheReadTokens,
    cacheWriteTokens: value.cacheWriteTokens,
    outputTokens: value.outputTokens,
    sessions: value.sessions.size,
    unpricedSessions: value.sessions.size - value.priced.size,
    unreportedTokenSessions: value.sessions.size - value.measured.size,
  };
}

function group<K>(groups: Map<K, Accumulator>, key: K): Accumulator {
  let value = groups.get(key);
  if (!value) {
    value = accumulator();
    groups.set(key, value);
  }
  return value;
}

const zeroTokens: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

function estimateReportCost(row: z.infer<typeof Report>, usage: Usage | null, tokens: Amounts): number | null {
  if (row.agent !== "codex" || !usage) return null;
  return estimateCodexCost({ model: usage.model ?? row.model, fastMode: usage.fastMode ?? Boolean(row.fast), tokens, requestInputTokens: usage.requestInputTokens ?? usage.contextTokens });
}

function countReport({ agent, usage, session, previous }: { agent: HarnessId; usage: Usage | null; session: string; previous: Map<string, Usage> }): Amounts {
  if (!usage) return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null };
  const before = previous.get(session) ?? zeroTokens;
  previous.set(session, { ...before, ...usage });
  // Codex and Pi supply running counters; the other adapters preserve prompt reports.
  const cumulative = agent === "codex" || agent === "pi";
  const delta = (value = 0, earlier = 0) => (cumulative ? Math.max(0, value - earlier) : value);
  const input = delta(usage.inputTokens, before.inputTokens);
  const read = delta(usage.cacheReadTokens, before.cacheReadTokens);
  const write = delta(usage.cacheWriteTokens, before.cacheWriteTokens);
  return {
    costUsd: usage.costUsd === undefined ? null : Math.max(0, usage.costUsd - (before.costUsd ?? 0)),
    inputTokens: agent === "codex" ? Math.max(0, input - read - write) : input,
    cacheReadTokens: read,
    cacheWriteTokens: write,
    outputTokens: delta(usage.outputTokens, before.outputTokens),
  };
}

/**
 * Read the small accounting fields, never transcript text. Earlier reports establish the baseline for resumed
 * sessions; only differences observed inside the requested period contribute. Hosted child reports are already
 * included in their parent's cost. Independently launched sessions retain their own accounting.
 */
export function usageHistory(db: Db, { boundaries, agent }: RpcParams<"usage.history">): UsageHistory {
  const start = boundaries[0]!;
  const end = boundaries.at(-1)!;
  const total = accumulator();
  const agents = new Map<HarnessId, Accumulator>();
  const models = new Map<string, { agent: HarnessId; model: string | null; value: Accumulator }>();
  const buckets = boundaries.slice(0, -1).map((start) => ({ start, total: accumulator(), agents: new Map<HarnessId, Accumulator>() }));
  const previous = new Map<string, Usage>();
  let bucketIndex = 0;
  const reports = db
    .stmt(
      `
    WITH reporting_runs AS MATERIALIZED (
      SELECT id, agent, claude_account_id AS account, COALESCE(external_session_id, id) AS session, model, fast_mode AS fast FROM runs r
      WHERE (? IS NULL OR r.agent = ?)
        AND NOT EXISTS (SELECT 1 FROM subagents s WHERE s.run_id = r.id OR s.thread_id = r.thread_id)
    ), active_sessions AS MATERIALIZED (
      SELECT DISTINCT agent, account, session FROM reporting_runs r
      WHERE EXISTS (
        SELECT 1 FROM usage_reports u WHERE u.run_id = r.id AND u.ts >= ? AND u.ts < ?
          AND (u.kind = 'turn.completed' OR r.agent = 'codex')
      )
    )
    SELECT u.ts, u.kind, r.agent, r.account, r.session, r.model, r.fast, u.usage
    FROM reporting_runs r
    JOIN active_sessions s ON s.agent = r.agent AND s.account IS r.account AND s.session = r.session
    JOIN usage_reports u ON u.run_id = r.id
    WHERE u.ts < ? AND (u.kind = 'turn.completed' OR r.agent = 'codex')
    ORDER BY u.ts, u.event_id
  `,
    )
    .iterate(agent ?? null, agent ?? null, start, end, end);

  for (const record of reports) {
    const row = Report.parse(record);
    const session = JSON.stringify([row.agent, row.account, row.session]);
    const parsed = row.usage === null ? null : Usage.safeParse(JSON.parse(row.usage));
    const usage = parsed?.success ? parsed.data : null;
    const amounts = countReport({ agent: row.agent, usage, session, previous });
    if (row.ts < start) continue;
    const modelId = usage?.model ?? row.model;
    amounts.costUsd ??= estimateReportCost(row, usage, amounts);
    while (bucketIndex + 1 < buckets.length && row.ts >= boundaries[bucketIndex + 1]!) bucketIndex++;
    const bucket = buckets[bucketIndex]!;
    add(total, session, amounts, usage !== null);
    add(group(agents, row.agent), session, amounts, usage !== null);
    add(bucket.total, session, amounts, usage !== null);
    add(group(bucket.agents, row.agent), session, amounts, usage !== null);
    const modelKey = JSON.stringify([row.agent, modelId]);
    let model = models.get(modelKey);
    if (!model) {
      model = { agent: row.agent, model: modelId, value: accumulator() };
      models.set(modelKey, model);
    }
    add(model.value, session, amounts, usage !== null);
  }
  const agentTotals = (values: Map<HarnessId, Accumulator>) => Array.from(values, ([agent, value]) => ({ agent, ...totals(value) }));
  return {
    total: totals(total),
    agents: agentTotals(agents),
    models: Array.from(models.values(), ({ agent, model, value }) => ({ agent, model, ...totals(value) })),
    buckets: buckets.map((bucket) => ({ start: bucket.start, total: totals(bucket.total), agents: agentTotals(bucket.agents) })),
  };
}
