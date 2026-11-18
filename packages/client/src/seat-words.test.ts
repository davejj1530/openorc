import { describe, expect, it } from "vitest";
import type { OrganizationAccess } from "@openorc/protocol";
import { allowanceSourceWords, graceDeadlineWords, organizationAccessAt, seatDeadline } from "./seat-words.js";

describe("private seat words", () => {
  it("uses only the selected source, preserving absent or unselected funding", () => {
    expect(allowanceSourceWords(undefined)).toBeNull();
    expect(allowanceSourceWords(null)).toBeNull();
    expect(allowanceSourceWords({ kind: "self" })).toBe("Paid by you");
    expect(allowanceSourceWords({ kind: "organization", organizationId: "team", organizationName: "Studio" })).toBe("Paid by Studio");
  });

  it.each([
    ["seat_removed", "Your seat was taken back, and your day of grace has ended."],
    ["payment_failed", "Payment for your Pro wasn't completed within a day."],
    ["subscription_ended", "Your Pro subscription ended, and your day of grace has ended."],
  ] as const)("closes %s at the exact deadline without extending it", (reason, message) => {
    const grace: OrganizationAccess = { state: "grace", reason, until: 1000, message: "Private grace sentence" };
    expect(organizationAccessAt(grace, 999)).toBe(grace);
    expect(organizationAccessAt(grace, 1000)).toEqual({ state: "frozen", reason, until: null, message });
    expect(organizationAccessAt(grace, 5000)).toEqual(organizationAccessAt(grace, 1000));
  });

  it("does not invent grace for an old server or a never-paid joiner", () => {
    expect(organizationAccessAt(undefined, 1000)).toBeUndefined();
    const frozen: OrganizationAccess = { state: "frozen", reason: "no_pro", until: null, message: "You need Pro to use an organization. Open Account or ask an admin for a seat." };
    expect(organizationAccessAt(frozen, 1000)).toBe(frozen);
  });

  it("changes tomorrow to today at local midnight, retaining the exact short deadline", () => {
    const until = Date.parse("2026-11-15T06:05:00Z");
    expect(graceDeadlineWords(until, Date.parse("2026-11-14T15:59:59Z"), "en-GB", "Asia/Singapore")).toEqual({ long: "Pro ends tomorrow at 14:05", short: "Pro ends Sun 14:05" });
    expect(graceDeadlineWords(until, Date.parse("2026-11-14T16:00:00Z"), "en-GB", "Asia/Singapore").long).toBe("Pro ends today at 14:05");
  });

  it("keeps the short words short on a twelve-hour clock, still naming the day and the time", () => {
    const until = Date.parse("2026-11-17T20:54:00Z");
    expect(graceDeadlineWords(until, Date.parse("2026-11-16T21:00:00Z"), "en-US", "America/Los_Angeles")).toEqual({ long: "Pro ends tomorrow at 12:54 PM", short: "Pro ends Tue 12:54 PM" });
  });

  it("names the date for a deadline further off than tomorrow, where a weekday alone could mislead", () => {
    const until = Date.parse("2026-11-25T06:05:00Z");
    expect(graceDeadlineWords(until, Date.parse("2026-11-14T06:05:00Z"), "en-GB", "Asia/Singapore")).toEqual({ long: "Pro ends 25 Nov, 14:05", short: "Pro ends 25 Nov, 14:05" });
  });

  it("compares calendar days across a daylight-saving change and year boundary", () => {
    expect(graceDeadlineWords(Date.parse("2026-11-01T18:00:00Z"), Date.parse("2026-10-31T17:00:00Z"), "en-GB", "America/New_York").long).toBe("Pro ends tomorrow at 13:00");
    expect(graceDeadlineWords(Date.parse("2027-01-01T06:05:00Z"), Date.parse("2026-12-31T06:05:00Z"), "en-GB", "Asia/Singapore").long).toBe("Pro ends tomorrow at 14:05");
  });

  it("uses the existing local short-day convention for absolute deadlines", () => {
    expect(seatDeadline(Date.parse("2026-11-15T06:05:00Z"), "en-GB", "Asia/Singapore")).toBe("15 Nov, 14:05");
    expect(seatDeadline(Date.parse("2026-11-15T06:05:00Z"), "en-US", "Asia/Singapore")).toBe("Nov 15, 2:05 PM");
  });
});
