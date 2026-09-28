import { describe, expect, it } from "vitest";
import { allowanceState } from "./provider-usage";
const report = { id: "5h", label: "5-hour", usedPercent: 50, remainingPercent: 50, resetsAt: 2_000_000, observedAt: 1_000_000, exhausted: false };
describe("usage freshness", () => {
  it("marks old and expired reports stale without inferring a reset to zero", () => {
    expect(allowanceState(report, 1_000_000)).toEqual({ stale: false, expired: false });
    expect(allowanceState(report, 1_300_000)).toEqual({ stale: true, expired: false });
    expect(allowanceState(report, 2_000_000)).toEqual({ stale: true, expired: true });
    expect(report.remainingPercent).toBe(50);
  });
});
