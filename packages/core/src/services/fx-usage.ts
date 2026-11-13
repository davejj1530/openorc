import type { FxUsageReport, FxUsageResult } from "@openorc/agents";
import type { AllowanceWindow, ProviderUsage } from "@openorc/protocol";

type Report = Pick<ProviderUsage, "status" | "context" | "plan" | "windows" | "credits" | "refreshedAt" | "message">;
const percent = (used: number | null | undefined, limit: number | null | undefined): number | null => {
  if (used == null || limit == null || limit <= 0) return null;
  const value = (used / limit) * 100;
  return Number.isFinite(value) ? value : null;
};

function window(id: string, label: string, used: number | null, resetsAt: number | null, observedAt: number, reached = false): AllowanceWindow {
  return { id, label, usedPercent: used, remainingPercent: used === null ? null : Math.max(0, 100 - used), resetsAt, observedAt, exhausted: reached || (used !== null && used >= 100) };
}

function budgetReset(period: string, at: number): number | null {
  const date = new Date(at);
  if (period === "daily") return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  if (period === "monthly") return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  return null;
}

function duration(seconds: number | null | undefined): string {
  if (!seconds) return "Allowance";
  if (seconds % 86_400 === 0) return `${seconds / 86_400}-day window`;
  if (seconds % 3600 === 0) return `${seconds / 3600}-hour window`;
  return `${seconds / 60}-minute window`;
}

function codexLimits(report: Report, usage: NonNullable<FxUsageReport["codex"]>, at: number): void {
  report.plan = usage.plan ?? null;
  for (const [index, limit] of usage.limits.entries()) {
    for (const kind of ["primary", "secondary"] as const) {
      const value = limit[kind];
      if (value)
        report.windows.push({
          ...window(`codex:${index}:${kind}`, `${limit.name} · ${duration(value.window_seconds)}`, value.used_percent ?? null, value.resets_at_ms ?? null, at, limit.reached),
          group: limit.name,
        });
    }
  }
  if (usage.credits) report.credits.push({ label: "Codex credits", balance: usage.credits.balance ?? null, unlimited: usage.credits.unlimited });
  if (usage.spend_limit_reached) report.message = "Codex reports that the account's spend limit has been reached.";
}

function grokLimits(report: Report, usage: NonNullable<FxUsageReport["grok"]>, at: number): void {
  report.plan = usage.settings?.plan ?? null;
  if (usage.used_percent != null) {
    const label = usage.period ? { weekly: "Weekly allowance", monthly: "Monthly allowance" }[usage.period] : "Plan allowance";
    report.windows.push(window("grok:plan", label, usage.used_percent, usage.resets_at_ms ?? null, at));
  }
  if (usage.on_demand_cap_cents != null) report.windows.push(window("grok:spend", "Monthly pay-as-you-go budget", percent(usage.on_demand_used_cents, usage.on_demand_cap_cents), null, at));
  if (usage.prepaid_cents != null) report.credits.push({ label: "Grok prepaid balance", balance: String(usage.prepaid_cents / 100), unlimited: false, currency: "USD" });
}

/** Account reports are separate from local run totals; a missing budget never becomes a guessed percentage. */
export function normalizeFx(live: FxUsageResult, at: number): Report {
  const result: Report = { status: "error", context: "fx provider account", plan: null, windows: [], credits: [], refreshedAt: null, message: null };
  if (live.status !== "ok") return { ...result, message: "Could not read fx usage. Check your connection and fx login, update fx if needed, then refresh." };
  const report = live.report;
  const observedAt = report.fetched_at_ms ?? at;
  result.refreshedAt = report.fetched_at_ms ?? null;
  result.context = { ai_gateway: "Vercel AI Gateway", chatgpt: "Codex subscription via fx", grok: "Grok subscription via fx" }[report.source];
  if (report.reason === "unsupported_provider")
    return { ...result, status: "unavailable", context: "fx custom provider", message: "fx does not report limits for this connection. Check your model provider's usage dashboard." };
  if (report.source === "chatgpt" && report.codex) codexLimits(result, report.codex, observedAt);
  if (report.source === "grok" && report.grok) grokLimits(result, report.grok, observedAt);
  if (report.source === "ai_gateway") gatewayLimits(result, live, observedAt);
  setReportStatus(result, report);
  if (result.refreshedAt === null && result.credits.length) result.refreshedAt = at;
  return result;
}

function gatewayLimits(result: Report, live: Extract<FxUsageResult, { status: "ok" }>, observedAt: number): void {
  const budget = live.report.budget;
  if (budget) {
    const label = { daily: "Daily budget", weekly: "Weekly budget", monthly: "Monthly budget", none: "Budget" }[budget.period];
    result.windows.push(window("gateway:budget", label, percent(budget.spent, budget.limit), budgetReset(budget.period, observedAt), observedAt));
  }
  result.plan = live.credits?.plan ?? null;
  if (live.credits?.balance != null) result.credits.push({ label: "AI Gateway balance", balance: live.credits.balance, unlimited: false, currency: "USD" });
}

function setReportStatus(result: Report, report: FxUsageReport): void {
  if (report.status === "ready") {
    result.status = result.windows.length || result.credits.length ? "available" : "unavailable";
    result.message ??= result.status === "available" ? null : "fx returned no limits or balance for this connection.";
  } else if (["no_gateway_sign_in", "refresh_needed", "refused"].includes(report.reason ?? "")) {
    result.status = "disconnected";
    result.context = "fx provider account";
    result.message = "Reconnect this provider in fx, then refresh usage. Any displayed limits are from the last report.";
  } else {
    result.status = "error";
    result.message = "fx could not refresh account limits. Any displayed limits are from the last report.";
  }
}
