import type { HarnessId, UsageTotals } from "@openorc/protocol";

export type UsagePeriod = "24h" | "7d" | "30d" | "90d";
export type UsageMetric = "cost" | "tokens";
export const usagePeriods = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
] satisfies { value: UsagePeriod; label: string }[];

/** Calendar days in the viewer's timezone; the rolling 24-hour view uses hourly buckets. */
export function usageBoundaries(period: UsagePeriod, now: number): number[] {
  if (period === "24h") return Array.from({ length: 25 }, (_, index) => now - (24 - index) * 3_600_000);
  const days = { "7d": 7, "30d": 30, "90d": 90 }[period];
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return [
    ...Array.from({ length: days }, (_, index) => {
      const day = new Date(today);
      day.setDate(today.getDate() - days + 1 + index);
      return day.getTime();
    }),
    Math.max(now, today.getTime() + 1),
  ];
}

export function processedTokens(value: UsageTotals): number {
  return value.inputTokens + value.cacheReadTokens + value.cacheWriteTokens + value.outputTokens;
}

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
export const formatTokens = (value: number) => compact.format(value);
export function usageValue(value: number | null, metric: UsageMetric): string {
  if (value === null) return metric === "cost" ? "Unavailable" : "Not reported";
  if (metric === "tokens") return formatTokens(value);
  return value > 0 && value < 0.005 ? "<$0.01" : currency.format(value);
}
export function metricValue(value: UsageTotals, metric: UsageMetric): number | null {
  if (metric === "cost") return value.costUsd;
  if (value.sessions > 0 && value.unreportedTokenSessions === value.sessions) return null;
  return processedTokens(value);
}
export function secondaryUsage(value: UsageTotals, metric: UsageMetric): string {
  if (metric === "tokens") return value.costUsd === null ? "Cost unavailable" : usageValue(value.costUsd, "cost");
  return metricValue(value, "tokens") === null ? "Tokens not reported" : `${formatTokens(processedTokens(value))} tokens`;
}
export function usageShare(value: number | null, total: number | null): string {
  if (value === null || total === null || total === 0) return "";
  const percent = (100 * value) / total;
  return percent > 0 && percent < 0.1 ? "<0.1%" : `${percent.toFixed(1)}%`;
}
const agentColors: Partial<Record<HarnessId, string>> = {
  codex: "var(--ink)",
  claude: "#d97757",
  opencode: "#1192c9",
  omp: "#cf8400",
  cursor: "var(--ink-3)",
  pi: "#0f9b96",
  antigravity: "#8b5cf6",
};
export const agentColor = (agent: HarnessId): string => agentColors[agent] ?? "var(--ink-2)";
export const bucketLabel = (start: number, period: UsagePeriod) =>
  new Date(start).toLocaleString(undefined, period === "24h" ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric" });
