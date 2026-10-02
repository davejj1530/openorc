import { CodexResetService, type ResetInput } from "./provider-resets.js";
import { captureLaunchEnvironment, readClaudeUsage, readCodexUsage, consumeCodexReset } from "@openorc/agents";
import { settings, type Db } from "@openorc/db";
import {
  harnessCatalog,
  harnessFailsToStart,
  harnessInfo,
  harnessInstalled,
  harnessLoggedIn,
  type AgentEvent,
  type AllowanceWindow,
  type HarnessId,
  type HarnessInfo,
  type ProviderUsage,
  type ResetResult,
  type MemorySettings,
} from "@openorc/protocol";
import type { SystemService } from "./system.js";
import type { EnvSnapshot } from "./shell-environment.js";

const record = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const text = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v.slice(0, 160) : null);
const number = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const timestamp = (v: unknown): number | null => {
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) && t > 0 ? t : null;
  }
  const n = number(v);
  return n !== null && n > 0 && n * 1000 <= 8.64e15 ? n * 1000 : null;
};
const fraction = (v: unknown): number | null => {
  const n = number(v);
  return n === null || n > 1 ? null : Math.round(n * 10_000) / 100;
};
const CLAUDE_REPORTS_KEY = "providerUsage.claude.windows";
const claudeLabels: Record<string, string> = {
  five_hour: "5-hour window",
  seven_day: "7-day window",
  seven_day_opus: "7-day window · Opus",
  seven_day_sonnet: "7-day window · Sonnet",
  overage: "Extra usage window",
};
const claudePlans: Record<string, string> = { pro: "Claude Pro", max: "Claude Max", team: "Claude Team", enterprise: "Claude Enterprise" };

function allowanceWindow({ id, label, used, resets, at, exhausted = false }: { id: string; label: string; used: unknown; resets: unknown; at: number; exhausted?: boolean }): AllowanceWindow {
  const usedPercent = number(used);
  return {
    id,
    label,
    usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
    resetsAt: timestamp(resets),
    observedAt: at,
    exhausted: exhausted || (usedPercent !== null && usedPercent >= 100),
  };
}

function duration(v: unknown, fallback: string): string {
  const mins = number(v);
  if (!mins) return `${fallback} window (duration unavailable)`;
  if (mins % 1440 === 0) return `${mins / 1440}-day window`;
  if (mins % 60 === 0) return `${mins / 60}-hour window`;
  return `${mins}-minute window`;
}

function codexLimitEntries(root: Record<string, unknown>): [string, unknown][] {
  const entries = Object.entries(record(root["rateLimitsByLimitId"]));
  if (entries.length) return entries;
  if (root["rateLimits"]) return [["codex", root["rateLimits"]]];
  return [];
}

function claudeLimitLabel({ group, kind, scope }: { group: string | null; kind: string; scope: string | null }): string {
  let base = kind.replace(/_/g, " ");
  if (group === "session") base = "5-hour window";
  else if (group === "weekly") base = "7-day window";
  if (scope) return `${base} · ${scope}`;
  if (kind === "weekly_all") return `${base} · all models`;
  return base;
}

/** The map supersedes the legacy single bucket; do not double count it. */
export function normalizeCodex(limits: unknown, at: number): Pick<ProviderUsage, "windows" | "credits" | "message"> {
  const root = record(limits);
  const windows: AllowanceWindow[] = [];
  const credits: ProviderUsage["credits"] = [];
  let reached = root["ordinaryUsageAllowed"] === false;
  for (const [id, value] of codexLimitEntries(root)) {
    const bucket = record(value);
    const label = text(bucket["limitName"]) ?? text(bucket["limitId"]) ?? id;
    const plan = text(bucket["planType"]);
    const prefix = plan ? `${label} · ${plan}` : label;
    reached ||= Boolean(bucket["rateLimitReachedType"]) || bucket["spendControlReached"] === true;
    for (const key of ["primary", "secondary"] as const) {
      if (!bucket[key]) continue;
      const limit = record(bucket[key]);
      const label = `${prefix} · ${duration(limit["windowDurationMins"], key === "primary" ? "Primary" : "Secondary")}`;
      windows.push(allowanceWindow({ id: `${id}:${key}`, label, used: limit["usedPercent"], resets: limit["resetsAt"], at }));
    }
    const credit = record(bucket["credits"]);
    if (bucket["credits"]) credits.push({ label: `${label} · workspace credits`, balance: text(credit["balance"]), unlimited: credit["unlimited"] === true });
    const spend = record(bucket["individualLimit"]);
    if (bucket["individualLimit"]) {
      const remaining = number(spend["remainingPercent"]);
      windows.push(
        allowanceWindow({
          id: `${id}:spend`,
          label: `${prefix} · individual spend limit`,
          used: remaining !== null && remaining <= 100 ? 100 - remaining : null,
          resets: spend["resetsAt"],
          at,
          exhausted: bucket["spendControlReached"] === true,
        }),
      );
    }
  }
  return {
    windows,
    credits,
    message: reached ? "The provider reports a reached limit. Check your provider account for recovery options; a reset time alone does not confirm access has resumed." : null,
  };
}

/** rate_limit_event: current CLIs report every window under unifiedWindows; older ones report one window at the top level. */
export function normalizeClaude(payload: unknown, at: number): AllowanceWindow[] {
  const event = record(payload);
  if (event["type"] !== "rate_limit_event") return [];
  const info = record(event["rate_limit_info"] ?? event["rateLimitInfo"]);
  const type = text(info["rateLimitType"] ?? info["rate_limit_type"]);
  const unified = record(info["unifiedWindows"]);
  const entries = Object.entries(unified);
  if (!entries.length && type) entries.push([type, info]);
  const windows: AllowanceWindow[] = [];
  for (const [id, value] of entries) {
    if (!claudeLabels[id]) continue;
    const w = record(value);
    windows.push(
      allowanceWindow({ id, label: claudeLabels[id], used: fraction(w["utilization"]), resets: w["resetsAt"] ?? w["resets_at"], at, exhausted: info["status"] === "rejected" && id === type }),
    );
  }
  return windows;
}

/** The plan rate limits as Claude Code reports them: percent utilization per limit, ISO reset times, and optional extra-usage spend. */
export function normalizeClaudeAccount(payload: unknown, at: number): Pick<ProviderUsage, "windows" | "credits" | "message"> {
  const root = record(payload);
  const windows: AllowanceWindow[] = [];
  const limits = Array.isArray(root["limits"]) ? root["limits"] : [];
  for (const value of limits) {
    const limit = record(value);
    const kind = text(limit["kind"]);
    if (!kind) continue;
    const model = record(record(limit["scope"])["model"]);
    const scope = text(model["display_name"]) ?? text(model["id"]);
    const group = text(limit["group"]);
    const label = claudeLimitLabel({ group, kind, scope });
    windows.push(allowanceWindow({ id: scope ? `${kind}:${scope}` : kind, label, used: limit["percent"], resets: limit["resets_at"], at }));
  }
  if (!windows.length) {
    for (const [id, label] of Object.entries(claudeLabels)) {
      if (!root[id]) continue;
      const w = record(root[id]);
      windows.push(allowanceWindow({ id, label, used: w["utilization"], resets: w["resets_at"], at, exhausted: Boolean(w["locked_reason"]) }));
    }
    // The CLI's own per-model view of the weekly windows, present when it answered from a fresh report.
    for (const value of Array.isArray(root["model_scoped"]) ? root["model_scoped"] : []) {
      const w = record(value);
      const model = text(w["display_name"]);
      if (model) windows.push(allowanceWindow({ id: `model_scoped:${model}`, label: `7-day window · ${model}`, used: w["utilization"], resets: w["resets_at"], at }));
    }
  }
  const extra = record(root["extra_usage"]);
  if (extra["is_enabled"] === true)
    windows.push(allowanceWindow({ id: "extra_usage", label: "Extra usage · monthly spend", used: extra["utilization"], resets: null, at, exhausted: extra["spend_limit_reached"] === true }));
  return { windows, credits: [], message: null };
}

export interface ProviderUsageReaders {
  codex?: typeof readCodexUsage;
  consumeReset?: typeof consumeCodexReset;
  claude?: typeof readClaudeUsage;
  apiKey?: () => Promise<Pick<MemorySettings, "hasApiKey" | "apiKeyError">>;
}

/** How one installed harness reports its account allowance. */
interface HarnessUsageReader {
  /** Where the numbers come from, shown on the report. */
  source: string;
  /** Fills in the report for an installed harness; `row` is its current probe result. */
  read(result: ProviderUsage, at: number, row: HarnessInfo, snapshot: EnvSnapshot | undefined): Promise<ProviderUsage>;
  /** Drops anything remembered from the account once the harness is gone. */
  forget?(): void;
}

export class ProviderUsageService {
  /** Windows Claude reported during runs in this app; the fallback when the account cannot be asked directly. */
  private readonly claude: Map<string, AllowanceWindow>;
  private readonly inFlight = new Map<string, Promise<ProviderUsage>>();
  private readonly codex: typeof readCodexUsage;
  private readonly resets: CodexResetService;
  private readonly apiKey: NonNullable<ProviderUsageReaders["apiKey"]>;
  private readonly claudeAccount: typeof readClaudeUsage;
  private readonly harnesses: Record<HarnessId, HarnessUsageReader> = {
    codex: { source: "Codex app-server · account usage", read: (result, _at, _row, snapshot) => this.readCodex(result, snapshot) },
    claude: {
      source: "Claude Code · account usage",
      forget: () => this.forgetClaude(),
      read: (result, at, row, snapshot) => {
        if (harnessLoggedIn(row)) return this.readClaude(result, at, snapshot);
        this.forgetClaude();
        result.status = "disconnected";
        result.message = `Run ${harnessCatalog.claude.loginCommand} in a terminal, then refresh connections.`;
        return Promise.resolve(result);
      },
    },
    opencode: {
      source: "OpenCode provider accounts",
      read: (result) => {
        result.context = "Provider accounts signed into OpenCode";
        result.message = "OpenCode bills each model through the provider account it was signed into. Allowances and spend are shown on that provider's own dashboard.";
        return Promise.resolve(result);
      },
    },
  };

  constructor(
    private readonly db: Db,
    private readonly system: Pick<SystemService, "info" | "infoFor">,
    readers: ProviderUsageReaders = {},
    private readonly environment?: () => EnvSnapshot,
    private readonly now = Date.now,
  ) {
    this.apiKey = readers.apiKey ?? (async () => ({ hasApiKey: false }));
    this.codex = readers.codex ?? readCodexUsage;
    this.resets = new CodexResetService(db, readers.consumeReset, this.now);
    this.claudeAccount = readers.claude ?? readClaudeUsage;
    this.claude = new Map(restoreWindows(settings.get(db, CLAUDE_REPORTS_KEY)).map((w) => [w.id, w]));
  }

  /** Claude Code's stream carries the account's rate limits; no other harness reports them this way. */
  observe(event: AgentEvent): void {
    if (event.type !== "raw" || event.agent !== "claude") return;
    const windows = normalizeClaude(event.payload, event.ts);
    if (!windows.length) return;
    for (const w of windows) this.claude.set(w.id, w);
    settings.set(this.db, CLAUDE_REPORTS_KEY, JSON.stringify([...this.claude.values()]));
  }

  read(provider: ProviderUsage["provider"]): Promise<ProviderUsage> {
    const pending = this.inFlight.get(provider);
    if (pending) return pending;
    const next = this.fetch(provider).finally(() => this.inFlight.delete(provider));
    this.inFlight.set(provider, next);
    return next;
  }

  async redeemCodex(input: ResetInput): Promise<ResetResult> {
    const snapshot = this.environment?.();
    this.resets.observeRevision(snapshot?.revision);
    const launch = snapshot ? captureLaunchEnvironment("codex", snapshot) : undefined;
    const result = await this.resets.redeem(input, launch ? { binary: launch.binary, env: launch.env } : {}, launch?.binary ?? "codex");
    // A read that started before redemption cannot be the post-reset report.
    await this.inFlight.get("codex");
    return { ...result, usage: await this.fetch("codex") };
  }

  private forgetClaude(): void {
    this.claude.clear();
    settings.remove(this.db, CLAUDE_REPORTS_KEY);
  }

  /** Asks the installed CLI for the plan windows of the login it holds; OpenOrc never touches that credential. */
  private async readClaude(result: ProviderUsage, at: number, snapshot: EnvSnapshot | undefined): Promise<ProviderUsage> {
    const launch = snapshot ? captureLaunchEnvironment("claude", snapshot) : undefined;
    const live = await this.claudeAccount(launch ? { binary: launch.binary, env: launch.env } : undefined).catch((): { status: "error" } => ({ status: "error" }));
    if (live.status === "ok") {
      Object.assign(result, normalizeClaudeAccount(live.usage, at));
      result.source = "Claude Code · live account usage";
      result.context = live.subscriptionType ? (claudePlans[live.subscriptionType] ?? `Claude ${live.subscriptionType}`) : "Claude Code login";
      result.refreshedAt = at;
      result.status = result.windows.length ? "available" : "unavailable";
      result.message ??= result.status === "unavailable" ? "The account returned no allowance metrics. Check your account usage page." : null;
      return result;
    }
    if (live.status === "unsupported") {
      result.context = "API key or cloud provider";
      result.message = "This Claude Code login bills through an API key or a cloud provider, so plan allowances do not apply. Check that provider's billing dashboard.";
      return result;
    }
    result.windows = [...this.claude.values()];
    result.refreshedAt = result.windows.length ? Math.max(...result.windows.map((w) => w.observedAt)) : null;
    result.status = observedUsageStatus(result.windows.length > 0, live.status === "error");
    result.context = "Account reported by Claude runs in this app";
    const fallback = result.windows.length ? " Showing the latest windows reported during Claude runs in this app instead." : "";
    result.message =
      live.status === "unavailable"
        ? `Claude Code did not report live usage: ${live.detail}. Refresh to try again.${fallback}`
        : `Could not fetch live usage. Check your connection, then refresh.${fallback}`;
    return result;
  }

  private async readCodex(result: ProviderUsage, snapshot: EnvSnapshot | undefined): Promise<ProviderUsage> {
    this.resets.observeRevision(snapshot?.revision);
    const launch = snapshot ? captureLaunchEnvironment("codex", snapshot) : undefined;
    const { account, limits } = await this.codex(launch ? { binary: launch.binary, env: launch.env } : undefined);
    const a = record(account);
    if (!account) {
      result.status = "disconnected";
      result.message = "No Codex account was reported. Run codex login, or check your custom provider configuration, then refresh.";
      return result;
    }
    if (a["type"] !== "chatgpt") {
      result.context = a["type"] === "apiKey" ? "OpenAI API key" : "External API provider";
      result.accountUrl = "https://platform.openai.com/usage";
      result.message = "API spending, remaining credits, and reset times are unavailable through Codex. Check your API provider’s billing dashboard.";
      return result;
    }
    result.context = `ChatGPT · ${text(a["planType"]) ?? "plan unavailable"}${text(a["email"]) ? ` · ${text(a["email"])}` : ""}`;
    Object.assign(result, normalizeCodex(limits, this.now()));
    result.resets = this.resets.describe({ account, limits }, launch?.binary ?? "codex");
    result.refreshedAt = this.now();
    result.status = result.windows.length || result.credits.length || result.resets.availableCount !== null ? "available" : "unavailable";
    result.message ??= result.status === "unavailable" ? "The provider returned no allowance metrics. Check your account usage page." : null;
    return result;
  }

  private async readApi(at: number): Promise<ProviderUsage> {
    const { hasApiKey: saved, apiKeyError } = await this.apiKey().catch(() => ({
      hasApiKey: false,
      apiKeyError: "Cannot access protected memory storage. Unlock your OS keychain or secret service and retry.",
    }));
    return {
      provider: "anthropic-api",
      status: apiUsageStatus(Boolean(apiKeyError), saved),
      source: "OpenOrc API configuration",
      context: "Anthropic API · memory distillation",
      checkedAt: at,
      refreshedAt: null,
      message:
        apiKeyError ??
        (saved
          ? "API spending, credit balance, and reset times are unavailable through this connection. Organization billing requires separate permissions. View your usage in the Claude Console. OpenOrc does not record distillation token usage."
          : "No Anthropic API key is saved. Configure one in Memory & models."),
      windows: [],
      credits: [],
      accountUrl: "https://platform.claude.com/usage",
      localRuns: null,
    };
  }

  private async fetch(provider: ProviderUsage["provider"]): Promise<ProviderUsage> {
    // Capture before the first await. Provider checks and the usage process
    // must agree even if a Rescan publishes the next revision midway.
    const snapshot = this.environment?.();
    const at = this.now();
    if (provider === "anthropic-api") return this.readApi(at);
    const reader = this.harnesses[provider];
    const result: ProviderUsage = {
      provider,
      status: "unavailable",
      source: reader.source,
      context: "CLI account",
      checkedAt: at,
      refreshedAt: null,
      message: null,
      windows: [],
      credits: [],
      accountUrl: harnessCatalog[provider].accountUsageUrl,
      ...(provider === "claude"
        ? {
            resets: {
              availableCount: null,
              credits: null,
              redemption: "external" as const,
              message: "If you have a free reset, use it in Claude Settings → Usage on the web or in Claude Desktop. Return here to refresh your allowance.",
            },
          }
        : {}),
      localRuns: (this.db.stmt("SELECT COUNT(*) AS count FROM runs WHERE agent = ?").get(provider) as { count: number }).count,
    };
    try {
      const info = snapshot ? await this.system.infoFor(snapshot) : await this.system.info();
      const row = harnessInfo(info, provider);
      if (!harnessInstalled(row)) {
        reader.forget?.();
        result.status = "disconnected";
        result.message = `Install ${harnessCatalog[provider].name}, then refresh connections.`;
        return result;
      }
      if (harnessFailsToStart(row)) {
        result.status = "error";
        result.message = `${harnessCatalog[provider].name} fails to start. Reinstall it in Settings → Connections, then refresh.`;
        return result;
      }
      return await reader.read(result, at, row, snapshot);
    } catch {
      // Never forward CLI stderr, authentication payloads, or provider errors.
      return { ...result, status: "error", message: "Could not refresh usage. Check your connection and CLI login, update the CLI if needed, then try Refresh." };
    }
  }
}

function restoreWindows(json: string | null): AllowanceWindow[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((w): w is AllowanceWindow => typeof record(w)["id"] === "string" && typeof record(w)["observedAt"] === "number") : [];
  } catch {
    return [];
  }
}

function observedUsageStatus(hasWindows: boolean, failed: boolean): ProviderUsage["status"] {
  if (hasWindows) return "available";
  return failed ? "error" : "unavailable";
}
function apiUsageStatus(failed: boolean, saved: boolean): ProviderUsage["status"] {
  if (failed) return "error";
  return saved ? "unavailable" : "disconnected";
}
