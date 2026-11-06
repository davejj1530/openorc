import { expect, it } from "vitest";
import { sessionWindow, weeklyWindow } from "./provider-usage.js";

const report = { id: "5h", label: "5-hour", usedPercent: 50, remainingPercent: 50, resetsAt: 2_000_000, observedAt: 1_000_000, exhausted: false };

it("finds the account's week-long limit, account-wide before a single model's", () => {
  const limit = (id: string, label: string, usedPercent: number | null = 40) => ({ ...report, id, label, usedPercent, remainingPercent: null });
  expect(weeklyWindow([limit("five_hour", "5-hour window"), limit("model_scoped:Fable", "7-day window · Fable"), limit("weekly_all", "7-day window · all models")])?.id).toBe("weekly_all");
  expect(weeklyWindow([limit("codex:primary", "codex · pro · 5-hour window"), limit("codex:secondary", "codex · pro · 7-day window")])?.id).toBe("codex:secondary");
  expect(weeklyWindow([limit("seven_day_opus", "7-day window · Opus")])?.id).toBe("seven_day_opus");
  expect(weeklyWindow([limit("session", "Current session"), limit("weekly", "Weekly limit")])?.id).toBe("weekly");
  expect(weeklyWindow([limit("five_hour", "5-hour window"), limit("seven_day", "7-day window", null)])).toBeNull();
});

it("finds the account's short rolling limit, never a week-long one or one without a share", () => {
  const limit = (id: string, label: string, usedPercent: number | null = 40) => ({ ...report, id, label, usedPercent, remainingPercent: null });
  expect(sessionWindow([limit("seven_day", "7-day window"), limit("five_hour", "5-hour window")])?.id).toBe("five_hour");
  expect(sessionWindow([limit("codex:secondary", "7-day window"), limit("codex:primary", "5-hour window")])?.id).toBe("codex:primary");
  expect(sessionWindow([limit("session", "Current session"), limit("weekly", "Weekly limit")])?.id).toBe("session");
  expect(sessionWindow([limit("five_hour", "5-hour window", null), limit("seven_day", "7-day window")])).toBeNull();
  expect(sessionWindow([limit("extra_usage", "Extra usage · monthly spend")])).toBeNull();
});
