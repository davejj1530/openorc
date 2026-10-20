import { describe, expect, it } from "vitest";
import { allowanceState, usageResetLabel, weeklyWindow } from "./provider-usage";
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

it("finds the account's week-long limit, account-wide before a single model's", () => {
  const limit = (id: string, label: string, usedPercent: number | null = 40) => ({ ...report, id, label, usedPercent, remainingPercent: null });
  expect(weeklyWindow([limit("five_hour", "5-hour window"), limit("model_scoped:Fable", "7-day window · Fable"), limit("weekly_all", "7-day window · all models")])?.id).toBe("weekly_all");
  expect(weeklyWindow([limit("codex:primary", "codex · pro · 5-hour window"), limit("codex:secondary", "codex · pro · 7-day window")])?.id).toBe("codex:secondary");
  expect(weeklyWindow([limit("seven_day_opus", "7-day window · Opus")])?.id).toBe("seven_day_opus");
  expect(weeklyWindow([limit("session", "Current session"), limit("weekly", "Weekly limit")])?.id).toBe("weekly");
  expect(weeklyWindow([limit("five_hour", "5-hour window"), limit("seven_day", "7-day window", null)])).toBeNull();
});
