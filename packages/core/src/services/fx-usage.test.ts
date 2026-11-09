import { afterEach, describe, expect, it, vi } from "vitest";
import { Db } from "@openorc/db";
import type { FxUsageReport, FxUsageResult, readFxUsage } from "@openorc/agents";
import type { SystemInfo } from "@openorc/protocol";
import { normalizeFx } from "./fx-usage.js";
import { ProviderUsageService } from "./provider-usage.js";
import { readPlanLimits } from "./plan-limits.js";
import type { EnvSnapshot } from "./shell-environment.js";

const at = Date.parse("2027-01-14T12:00:00Z");
const base: FxUsageReport = { kind: "usage", schema_version: 2, source: "ai_gateway", status: "ready", fetched_at_ms: at };
const credits = { kind: "credits" as const, balance: "12.50", plan: null };
const live = (report: Partial<FxUsageReport> = {}): FxUsageResult => ({ status: "ok", report: { ...base, ...report }, credits });
const databases: Db[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("fx account usage", () => {
  it("shows Gateway balances without inventing a percentage or a subscription plan", () => {
    expect(normalizeFx(live(), at)).toMatchObject({
      status: "available",
      context: "Vercel AI Gateway",
      plan: null,
      windows: [],
      credits: [{ label: "AI Gateway balance", balance: "12.50", currency: "USD" }],
    });
  });

  it.each([
    ["daily", "Daily budget", "2027-01-15T00:00:00Z"],
    ["monthly", "Monthly budget", "2027-02-01T00:00:00Z"],
    ["weekly", "Weekly budget", null],
    ["none", "Budget", null],
  ] as const)("uses reported %s budgets and only known reset boundaries", (period, label, reset) => {
    expect(normalizeFx(live({ budget: { limit: 40, spent: 10, period } }), at).windows).toEqual([
      { id: "gateway:budget", label, usedPercent: 25, remainingPercent: 75, resetsAt: reset ? Date.parse(reset) : null, observedAt: at, exhausted: false },
    ]);
  });

  it("keeps zero or missing denominators unknown and preserves over-budget usage", () => {
    for (const limit of [0, null]) expect(normalizeFx(live({ budget: { limit, spent: 10, period: "weekly" } }), at).windows[0]).toMatchObject({ usedPercent: null, remainingPercent: null });
    expect(normalizeFx(live({ budget: { limit: 10, spent: 12, period: "none" } }), at).windows[0]).toMatchObject({ usedPercent: 120, remainingPercent: 0, exhausted: true });
  });

  it("preserves Codex limit groups and millisecond resets, without using Gateway credits", () => {
    const result = normalizeFx(
      live({
        source: "chatgpt",
        codex: {
          plan: "Pro",
          spend_limit_reached: true,
          credits: { balance: "3.5", unlimited: false },
          limits: [
            { name: "Codex", reached: false, primary: { used_percent: 0, window_seconds: 18000, resets_at_ms: at + 3600000 }, secondary: { used_percent: 83, window_seconds: 604800 } },
            { name: "Code review", reached: true, primary: { used_percent: 100, window_seconds: 604800 } },
          ],
        },
      }),
      at,
    );
    expect(result).toMatchObject({ plan: "Pro", status: "available", credits: [{ label: "Codex credits", balance: "3.5", unlimited: false }], message: expect.stringContaining("spend limit") });
    expect(result.windows).toMatchObject([
      { group: "Codex", label: "Codex · 5-hour window", remainingPercent: 100, resetsAt: at + 3600000 },
      { group: "Codex", label: "Codex · 7-day window", remainingPercent: 17, resetsAt: null },
      { group: "Code review", remainingPercent: 0, exhausted: true },
    ]);
  });

  it("maps Grok plan allowance, monthly PAYG cap and prepaid cents separately", () => {
    const result = normalizeFx(
      live({
        source: "grok",
        grok: { used_percent: 120, period: "weekly", resets_at_ms: at + 3600000, prepaid_cents: 1250, on_demand_used_cents: 400, on_demand_cap_cents: 2000, settings: { plan: "SuperGrok" } },
      }),
      at,
    );
    expect(result).toMatchObject({ plan: "SuperGrok", credits: [{ label: "Grok prepaid balance", balance: "12.5", currency: "USD" }] });
    expect(result.windows).toMatchObject([
      { label: "Weekly allowance", remainingPercent: 0, exhausted: true, resetsAt: at + 3600000 },
      { label: "Monthly pay-as-you-go budget", remainingPercent: 80, resetsAt: null },
    ]);
  });

  it("distinguishes auth, unsupported connections, and cached reports after a failed refresh", () => {
    expect(normalizeFx(live({ status: "unavailable", reason: "unsupported_provider" }), at)).toMatchObject({ status: "unavailable", windows: [], credits: [] });
    expect(normalizeFx(live({ status: "failed", reason: "refused" }), at)).toMatchObject({ status: "disconnected", message: expect.stringContaining("Reconnect") });
    expect(normalizeFx({ status: "ok", report: { ...base, status: "failed", fetched_at_ms: at - 600000, budget: { limit: 20, spent: 10, period: "monthly" } }, credits: null }, at)).toMatchObject({
      status: "error",
      refreshedAt: at - 600000,
      windows: [{ observedAt: at - 600000, remainingPercent: 50 }],
      message: expect.stringContaining("last report"),
    });
    expect(normalizeFx({ status: "unavailable" }, at)).toMatchObject({ status: "error", windows: [], credits: [] });
  });

  it("uses the resolved environment, separates connection caches, and sends sanitized balances to phones", async () => {
    const db = Db.memory();
    databases.push(db);
    const snapshot: EnvSnapshot = {
      revision: 1,
      shell: "/bin/sh",
      path: "/opt/agents",
      env: { HOME: "/tmp/example-home", PATH: "/opt/agents" },
      binaries: { codex: null, claude: null, opencode: null, omp: null, cursor: null, pi: null, antigravity: null, fx: "/opt/agents/fx" },
    };
    const info: SystemInfo = {
      dataDir: "/tmp/example-data",
      harnesses: [{ id: "fx", state: "ready", path: snapshot.binaries.fx, version: "0.0.16", revision: 1 }],
      gh: { installed: false, path: null },
    };
    const reader = vi.fn<typeof readFxUsage>(async () => live());
    const usage = new ProviderUsageService(
      db,
      { info: async () => info, infoFor: async () => info },
      { fx: reader },
      () => snapshot,
      () => at,
    );
    const [a, b] = await Promise.all([usage.read("fx", undefined, "gateway/anthropic/example"), usage.read("fx", undefined, "gateway/anthropic/example")]);
    expect(a).toBe(b);
    expect(reader).toHaveBeenCalledExactlyOnceWith({ binary: "/opt/agents/fx", env: snapshot.env, model: "gateway/anthropic/example" });
    expect(await usage.recent("fx", undefined, 60000, "gateway/anthropic/example")).toBe(a);
    reader.mockResolvedValueOnce({ status: "ok", report: { ...base, source: "chatgpt" }, credits: null });
    expect((await usage.recent("fx", undefined, 60000, "codex/example")).context).toContain("Codex");
    expect(reader).toHaveBeenCalledTimes(2);
    expect(await usage.recent("fx", undefined, 60000, "gateway/another-model")).toBe(a);
    expect(reader).toHaveBeenCalledTimes(2);
    const phone = await readPlanLimits({ db, usage, availability: async () => [{ id: "fx", state: "ready" }] });
    expect(phone).toMatchObject([{ provider: "fx", status: "available", credits: [{ label: "AI Gateway balance", balance: "12.50", unlimited: false, currency: "USD" }] }]);
    expect(Object.keys(phone[0]!)).toEqual(["id", "provider", "name", "plan", "status", "windows", "credits", "refreshedAt"]);
    expect(reader).toHaveBeenCalledTimes(3);
  });
});
