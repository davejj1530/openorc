import { describe, expect, it } from "vitest";
import { creditBalanceLabel, allowanceState, usageMeter, usageResetLabel } from "./provider-usage.js";
const report = { id: "5h", label: "5-hour", usedPercent: 50, remainingPercent: 50, resetsAt: 2_000_000, observedAt: 1_000_000, exhausted: false };
describe("usage freshness", () => {
  it("marks old and expired reports stale without inferring a reset to zero", () => {
    expect(allowanceState(report, 1_000_000)).toEqual({ stale: false, expired: false });
    expect(allowanceState(report, 1_300_000)).toEqual({ stale: true, expired: false });
    expect(allowanceState(report, 2_000_000)).toEqual({ stale: true, expired: true });
    expect(report.remainingPercent).toBe(50);
  });
});

it("shows unavailable and elapsed resets explicitly instead of inventing a new allowance", () => {
  const now = Date.now();
  expect(usageResetLabel(null, now)).toBe("Reset time unavailable");
  expect(usageResetLabel(now, now)).toBe("Reset passed · refresh usage");
  expect(usageResetLabel(now + 30_000, now)).toBe("Resets in 1m");
  expect(usageResetLabel(now + 144 * 60_000, now)).toBe("Resets in 2h 24m");
});

it("formats monetary balances separately from credits and keeps an unknown balance unknown", () => {
  expect(creditBalanceLabel({ balance: "12.5", unlimited: false, currency: "USD" })).toBe("$12.50");
  expect(creditBalanceLabel({ balance: "12.5", unlimited: false })).toBe("12.5 credits");
  expect(creditBalanceLabel({ balance: "0", unlimited: false, currency: "USD" })).toBe("$0.00");
  expect(creditBalanceLabel({ balance: "", unlimited: false })).toBe("Balance unavailable");
  expect(creditBalanceLabel({ balance: null, unlimited: true })).toBe("Unlimited");
});

describe("a model pill's meter", () => {
  const window = (id: string, label: string, remainingPercent: number | null, group?: string) => ({ ...report, id, label, remainingPercent, usedPercent: null, ...(group ? { group } : {}) });
  const claude = { provider: "claude" as const, name: "Claude · Work" };

  it("measures the week's share left, amber at a tenth or less, and says whose it is", () => {
    const windows = [window("five_hour", "5-hour window", 80), window("seven_day", "7-day window · all models", 41.4)];
    expect(usageMeter(claude, { windows }, null)).toEqual({ left: 41.4, words: "41% left this week", label: "Claude · Work: 41% left this week", low: false });
    expect(usageMeter(claude, { windows: [window("seven_day", "7-day window", 10)] }, null)?.low).toBe(true);
  });

  it("shows nothing for an account with no weekly limit until its conversation has a cost to open on", () => {
    const windows = [window("five_hour", "5-hour window", 80)];
    expect(usageMeter(claude, { windows }, null)).toBeNull();
    expect(usageMeter(claude, undefined, null)).toBeNull();
    expect(usageMeter(claude, { windows }, 0.42)).toEqual({ left: null, words: "No weekly limit", label: "Claude · Work: no weekly limit", low: false });
  });

  it("measures Antigravity by its Gemini pool and fx by its first pool, or by its balance", () => {
    const antigravity = { provider: "antigravity" as const, name: "Antigravity" };
    expect(usageMeter(antigravity, { windows: [window("claude-weekly", "Weekly", 5), window("gemini-weekly", "Weekly", 70)] }, null)?.left).toBe(70);
    const fx = { provider: "fx" as const, name: "fx" };
    expect(usageMeter(fx, { windows: [window("a", "Monthly budget", 30, "pool-a"), window("b", "Weekly", 90, "pool-b")] }, null)?.words).toBe("30% left · Monthly budget");
    expect(usageMeter(fx, { windows: [], credits: [{ label: "Balance", balance: "0", unlimited: false, currency: "USD" }] }, null)).toEqual({
      left: null,
      words: "Balance: $0.00",
      label: "fx: Balance: $0.00",
      low: true,
    });
  });
});
