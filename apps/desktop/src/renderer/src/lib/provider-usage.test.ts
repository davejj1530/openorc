import { describe, expect, it } from "vitest";
import { allowanceState, usageResetLabel } from "./provider-usage";
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
