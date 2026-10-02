import { afterEach, describe, expect, it, vi } from "vitest";
import { Db, settings } from "@openorc/db";
import type { HarnessId, HarnessInfo, SystemInfo, MemorySettings } from "@openorc/protocol";
import type { ClaudeUsageOptions, ClaudeUsageResult } from "@openorc/agents";
import { normalizeClaude, normalizeClaudeAccount, normalizeCodex, ProviderUsageService, type ProviderUsageReaders } from "./provider-usage.js";
import type { EnvSnapshot } from "./shell-environment.js";

const at = 1_800_000_000_000;
const window = { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_001_000 };
const connected: SystemInfo = {
  dataDir: "/tmp",
  harnesses: [
    { id: "codex", state: "ready", path: "codex", version: "test", revision: 0 },
    { id: "claude", state: "ready", path: "claude", version: "test", revision: 0 },
  ],
  gh: { installed: true, path: "gh" },
};
/** The same machine with one harness's probe changed. */
const withHarness = (info: SystemInfo, id: HarnessId, patch: Partial<HarnessInfo>): SystemInfo => ({
  ...info,
  harnesses: info.harnesses.map((row) => (row.id === id ? { ...row, ...patch } : row)),
});
const databases: Db[] = [];
const account = {
  limits: [
    { kind: "session", group: "session", percent: 4, resets_at: "2026-09-15T20:30:00Z" },
    { kind: "weekly_all", group: "weekly", percent: 30, resets_at: "2026-09-19T23:00:00Z" },
    { kind: "weekly_scoped", group: "weekly", percent: 41, resets_at: "2026-09-19T23:00:00Z", scope: { model: { id: null, display_name: "Fable" } } },
  ],
  extra_usage: { is_enabled: false },
};
const rateLimitEvent = (five: number, seven: number) => ({
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    resetsAt: 1_800_001_000,
    rateLimitType: "five_hour",
    unifiedWindows: { five_hour: { utilization: five, resetsAt: 1_800_001_000 }, seven_day: { utilization: seven, resetsAt: 1_800_002_000 } },
  },
});
function setup(
  read = vi.fn(async (): Promise<{ account: unknown; limits: unknown }> => ({ account: { type: "chatgpt", planType: "pro" }, limits: { rateLimits: { primary: window } } })),
  db = Db.memory(),
  snapshot?: EnvSnapshot,
  consumeReset?: ProviderUsageReaders["consumeReset"],
) {
  if (!databases.includes(db)) databases.push(db);
  const system = { info: vi.fn(async () => connected), infoFor: vi.fn(async () => connected) };
  const claude = vi.fn(async (_options?: ClaudeUsageOptions): Promise<ClaudeUsageResult> => ({ status: "ok", usage: account, subscriptionType: "max" }));
  const apiKey = vi.fn(async (): Promise<Pick<MemorySettings, "hasApiKey" | "apiKeyError">> => ({ hasApiKey: false }));
  return { db, system, read, claude, apiKey, service: new ProviderUsageService(db, system, { codex: read, claude, apiKey, consumeReset }, snapshot ? () => snapshot : undefined, () => at) };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("provider normalization", () => {
  it("keeps windows and buckets separate and ignores the duplicate legacy view", () => {
    const r = normalizeCodex(
      {
        rateLimits: { primary: window },
        rateLimitsByLimitId: { codex: { primary: window, secondary: { ...window, usedPercent: 100, windowDurationMins: 10080 } }, spark: { primary: { ...window, usedPercent: 42 } } },
      },
      at,
    );
    expect(r.windows).toHaveLength(3);
    expect(r.windows[0]).toMatchObject({ usedPercent: 25, remainingPercent: 75, resetsAt: 1_800_001_000_000, label: "codex · 5-hour window" });
    expect(r.windows[1]).toMatchObject({ remainingPercent: 0, exhausted: true, label: "codex · 7-day window" });
  });
  it("preserves zero, clamps overages only in remaining, and rejects malformed numbers", () => {
    for (const [used, remaining] of [
      [0, 100],
      [125, 0],
      [null, null],
      [-1, null],
      [NaN, null],
      [Infinity, null],
      ["20", null],
    ] as const) {
      const r = normalizeCodex({ rateLimits: { primary: { usedPercent: used } } }, at);
      expect(r.windows[0]?.remainingPercent).toBe(remaining);
      expect(r.windows[0]?.resetsAt).toBeNull();
    }
    expect(normalizeCodex(null, at).windows).toEqual([]);
  });
  it("separates workspace credits and spend control from subscription allowance", () => {
    const r = normalizeCodex(
      { ordinaryUsageAllowed: false, rateLimits: { primary: window, credits: { balance: "0", unlimited: false }, individualLimit: { remainingPercent: 20, resetsAt: 1_800_001_000 } } },
      at,
    );
    expect(r.credits[0]).toMatchObject({ balance: "0", unlimited: false });
    expect(r.windows[1]).toMatchObject({ usedPercent: 80, remainingPercent: 20 });
    expect(r.message).toMatch(/reached limit/);
  });
  it("converts Claude fractions, keeps model windows and rejected partial reports", () => {
    expect(normalizeClaude({ type: "rate_limit_event", rate_limit_info: { rateLimitType: "seven_day_opus", utilization: 0.235, resetsAt: 1_800_001_000 } }, at)).toEqual([
      expect.objectContaining({ label: "7-day window · Opus", usedPercent: 23.5, remainingPercent: 76.5 }),
    ]);
    expect(normalizeClaude({ type: "rate_limit_event", rate_limit_info: { rate_limit_type: "five_hour", status: "rejected" } }, at)).toEqual([
      expect.objectContaining({ usedPercent: null, remainingPercent: null, exhausted: true }),
    ]);
    expect(normalizeClaude({ type: "result", usage: { input_tokens: 1000 } }, at)).toEqual([]);
  });
  it("reads every Claude window from unifiedWindows and marks only the rejected one exhausted", () => {
    const r = normalizeClaude({ ...rateLimitEvent(0.02, 0.29), rate_limit_info: { ...rateLimitEvent(0.02, 0.29).rate_limit_info, status: "rejected" } }, at);
    expect(r).toEqual([
      expect.objectContaining({ id: "five_hour", label: "5-hour window", usedPercent: 2, resetsAt: 1_800_001_000_000, exhausted: true }),
      expect.objectContaining({ id: "seven_day", label: "7-day window", usedPercent: 29, resetsAt: 1_800_002_000_000, exhausted: false }),
    ]);
    expect(normalizeClaude({ type: "rate_limit_event", rate_limit_info: { rateLimitType: "five_hour", unifiedWindows: { five_hour: {}, unknown_window: { utilization: 0.5 } } } }, at)).toEqual([
      expect.objectContaining({ id: "five_hour", usedPercent: null }),
    ]);
  });
  it("maps the account usage report onto labelled windows with percent values and ISO resets", () => {
    const r = normalizeClaudeAccount(account, at);
    expect(r.windows.map((w) => [w.id, w.label, w.usedPercent, w.resetsAt])).toEqual([
      ["session", "5-hour window", 4, Date.parse("2026-09-15T20:30:00Z")],
      ["weekly_all", "7-day window · all models", 30, Date.parse("2026-09-19T23:00:00Z")],
      ["weekly_scoped:Fable", "7-day window · Fable", 41, Date.parse("2026-09-19T23:00:00Z")],
    ]);
    const legacy = normalizeClaudeAccount(
      {
        five_hour: { utilization: 4, resets_at: "2026-09-15T20:30:00Z" },
        seven_day: null,
        seven_day_opus: { utilization: 100, locked_reason: "exceeded" },
        extra_usage: { is_enabled: true, utilization: 12.5, spend_limit_reached: false },
      },
      at,
    );
    expect(legacy.windows.map((w) => [w.id, w.usedPercent, w.exhausted])).toEqual([
      ["five_hour", 4, false],
      ["seven_day_opus", 100, true],
      ["extra_usage", 12.5, false],
    ]);
    const scoped = normalizeClaudeAccount({ five_hour: { utilization: 27 }, model_scoped: [{ display_name: "Fable", utilization: 38, resets_at: "2026-09-26T23:00:00Z" }, { utilization: 1 }] }, at);
    expect(scoped.windows.map((w) => [w.id, w.label, w.usedPercent])).toEqual([
      ["five_hour", "5-hour window", 27],
      ["model_scoped:Fable", "7-day window · Fable", 38],
    ]);
    expect(normalizeClaudeAccount(null, at).windows).toEqual([]);
  });
});

describe("usage refresh", () => {
  it("uses the actual post-redemption report and preserves the outcome if refreshing fails", async () => {
    const before = { account: { type: "chatgpt", email: "fixture@example.test" }, limits: { rateLimits: { primary: window }, rateLimitResetCredits: { availableCount: 2 } } };
    const read = vi.fn(async () => before);
    const consumeReset = vi.fn<NonNullable<ProviderUsageReaders["consumeReset"]>>(async (_input, _options, authorize) => {
      authorize(before);
      return "reset";
    });
    const { service } = setup(read, undefined, undefined, consumeReset);
    const report = await service.read("codex");
    // A provider can still report exhausted allowance or unchanged inventory.
    const result = await service.redeemCodex({ attemptId: "00000000-0000-4000-8000-000000000001", confirmationToken: report.resets!.confirmationToken! });
    expect(result).toMatchObject({ outcome: "reset", usage: { resets: { availableCount: 2 }, windows: [{ usedPercent: 25 }] } });
    expect(read).toHaveBeenCalledTimes(2);
    read.mockRejectedValueOnce(new Error("offline"));
    const failedRefresh = await service.redeemCodex({ attemptId: "00000000-0000-4000-8000-000000000002", confirmationToken: report.resets!.confirmationToken! });
    expect(failedRefresh).toMatchObject({ outcome: "reset", usage: { status: "error", windows: [] } });
  });
  it("deduplicates concurrent refreshes and performs another read afterward", async () => {
    const { service, read } = setup();
    await Promise.all([service.read("codex"), service.read("codex")]);
    expect(read).toHaveBeenCalledTimes(1);
    expect((await service.read("codex")).status).toBe("available");
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("uses one captured environment for both readiness and the usage process of each CLI", async () => {
    const env = Object.freeze({ PATH: "/snapshot", OPENORC_CODEX_BIN: "/snapshot/codex", OPENORC_CLAUDE_BIN: "/snapshot/claude" });
    const snapshot: EnvSnapshot = Object.freeze({
      revision: 7,
      shell: "/bin/zsh",
      path: env.PATH,
      binaries: Object.freeze({ claude: env.OPENORC_CLAUDE_BIN, codex: env.OPENORC_CODEX_BIN, opencode: null }),
      env,
    });
    const { service, system, read, claude } = setup(undefined, undefined, snapshot);

    await service.read("codex");
    await service.read("claude");

    expect(system.infoFor).toHaveBeenCalledWith(snapshot);
    expect(read).toHaveBeenCalledWith({ binary: "/snapshot/codex", env: snapshot.env });
    expect(claude).toHaveBeenCalledWith({ binary: "/snapshot/claude", env: snapshot.env });
  });
  it("sanitizes errors, recovers on retry, and does not block another provider", async () => {
    const { service, read } = setup();
    read.mockRejectedValueOnce(new Error("secret-token and stderr"));
    const r = await service.read("codex");
    expect(r.status).toBe("error");
    expect(JSON.stringify(r)).not.toContain("secret-token");
    expect((await service.read("claude")).status).toBe("available");
    expect((await service.read("codex")).status).toBe("available");
  });
  it("does not call Codex when missing and keeps missing data unavailable", async () => {
    const { service, system, read } = setup();
    system.info.mockResolvedValueOnce(withHarness(connected, "codex", { state: "not_found", path: null }));
    expect((await service.read("codex")).status).toBe("disconnected");
    expect(read).not.toHaveBeenCalled();
    read.mockResolvedValueOnce({ account: null, limits: null });
    expect((await service.read("codex")).status).toBe("disconnected");
    read.mockResolvedValueOnce({ account: { type: "apiKey" }, limits: null });
    const r = await service.read("codex");
    expect(r.context).toBe("OpenAI API key");
    expect(r.windows).toEqual([]);
    expect(r.status).toBe("unavailable");
  });
  it("sends a CLI that fails to start to the reinstall instead of asking its account", async () => {
    const { service, system, read } = setup();
    system.info.mockResolvedValueOnce(withHarness(connected, "codex", { state: "check_failed", version: null }));
    expect(await service.read("codex")).toMatchObject({ status: "error", message: "Codex fails to start. Reinstall it in Settings → Connections, then refresh." });
    expect(read).not.toHaveBeenCalled();
  });
  it("falls back to windows reported during runs when the account cannot be asked, keeping their report time", async () => {
    const { service, claude } = setup();
    service.observe({ type: "raw", agent: "claude", runId: "r1", ts: at - 600_000, payload: rateLimitEvent(0.5, 0.6) });
    for (const [live, status, message] of [
      [{ status: "unavailable", detail: "Claude timed out while reporting usage" }, "available", /timed out/],
      [{ status: "unavailable", detail: "get_usage is not supported in this context" }, "available", /not supported/],
    ] as const) {
      claude.mockResolvedValueOnce(live);
      const r = await service.read("claude");
      expect(r.status).toBe(status);
      expect(r.message).toMatch(message);
      expect(r.refreshedAt).toBe(at - 600_000);
      expect(r.windows.map((w) => [w.id, w.usedPercent])).toEqual([
        ["five_hour", 50],
        ["seven_day", 60],
      ]);
    }
    claude.mockRejectedValueOnce(new Error("Bearer secret-token"));
    const r = await service.read("claude");
    expect(r.status).toBe("available");
    expect(JSON.stringify(r)).not.toContain("secret-token");
  });
  it("reports an error only when live usage fails and no run has reported a window", async () => {
    const { service, claude } = setup();
    claude.mockRejectedValueOnce(new Error("offline"));
    expect((await service.read("claude")).status).toBe("error");
    claude.mockResolvedValueOnce({ status: "unavailable", detail: "Claude exited before reporting usage" });
    expect((await service.read("claude")).status).toBe("unavailable");
  });
  it("explains that plan windows do not apply to an API key or cloud provider login", async () => {
    const { service, claude } = setup();
    service.observe({ type: "raw", agent: "claude", runId: "r1", ts: at - 600_000, payload: rateLimitEvent(0.5, 0.6) });
    claude.mockResolvedValueOnce({ status: "unsupported" });
    const r = await service.read("claude");
    expect(r.status).toBe("unavailable");
    expect(r.windows).toEqual([]);
    expect(r.context).toBe("API key or cloud provider");
    expect(r.message).toMatch(/plan allowances do not apply/);
  });
  it("keeps run-reported Claude windows across restarts and drops them on logout", async () => {
    const db = Db.memory();
    const first = setup(undefined, db);
    first.service.observe({ type: "raw", agent: "claude", runId: "r1", ts: at - 600_000, payload: rateLimitEvent(0.5, 0.6) });
    const second = setup(undefined, db);
    second.claude.mockResolvedValueOnce({ status: "unavailable", detail: "Claude timed out while reporting usage" });
    expect((await second.service.read("claude")).windows.map((w) => w.usedPercent)).toEqual([50, 60]);
    second.system.info.mockResolvedValueOnce(withHarness(connected, "claude", { state: "sign_in" }));
    expect((await second.service.read("claude")).status).toBe("disconnected");
    expect(settings.get(db, "providerUsage.claude.windows")).toBeNull();
    const third = setup(undefined, db);
    third.claude.mockResolvedValueOnce({ status: "unavailable", detail: "Claude timed out while reporting usage" });
    expect((await third.service.read("claude")).windows).toEqual([]);
  });
  it("reports unavailable protected storage without mistaking it for an absent key", async () => {
    const { apiKey, service } = setup();
    apiKey.mockRejectedValueOnce(new Error("provider error with secret-fixture"));
    const failed = await service.read("anthropic-api");
    expect(failed.status).toBe("error");
    expect(failed.message).toMatch(/Unlock your OS keychain/);
    expect(JSON.stringify(failed)).not.toContain("secret-fixture");
    expect((await service.read("anthropic-api")).status).toBe("disconnected");
  });
  it("never returns the configured API key or invents a credit balance", async () => {
    const { apiKey, service } = setup();
    apiKey.mockResolvedValueOnce({ hasApiKey: true });
    const r = await service.read("anthropic-api");
    expect(r.status).toBe("unavailable");
    expect(r.credits).toEqual([]);
    expect(r.localRuns).toBeNull();
    expect(JSON.stringify(r)).not.toContain("private-api-key");
  });
});
