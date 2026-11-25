import { describe, expect, it } from "vitest";
import { cloudTime, hoursDetail, initials, periodLabel, planDate, planWords, priceText } from "./account-words.js";

const DEC_3 = Date.parse("2026-12-03T12:00:00Z");

describe("account words", () => {
  it("says cloud time in whole hours, and minutes under an hour", () => {
    expect(cloudTime(41 * 3600 + 3000)).toBe("41 h");
    expect(cloudTime(43 * 60 + 20)).toBe("43 min");
    expect(cloudTime(-5)).toBe("0 h");
    expect(cloudTime(30)).toBe("0 h");
  });

  it("writes a price from its smallest unit in the person's locale, and a period by its price or its name", () => {
    expect(priceText({ amount: 2000, currency: "usd" }, "en-US")).toBe("$20");
    expect(priceText({ amount: 1999, currency: "eur" }, "de-DE")).toBe("19,99\u00a0€");
    expect(priceText({ amount: 3000, currency: "jpy" }, "ja-JP")).toBe("￥3,000");
    expect(periodLabel("yearly", { amount: 20000, currency: "usd" }, "en-US")).toBe("$200 a year");
    expect(periodLabel("monthly", null)).toBe("Monthly");
  });

  it("puts the plan and the hours left in one line", () => {
    expect(planWords({ plan: { pro: false }, hours: null })).toEqual({ long: "Free", short: "Free" });
    expect(planWords({ plan: { pro: true, standing: "live", at: DEC_3 }, hours: { leftSeconds: 41 * 3600, monthly: null, packsLeftSeconds: 41 * 3600 } })).toEqual({
      long: "Pro · 41 h left",
      short: "41 h left",
    });
  });

  it("dates Pro by its standing", () => {
    expect(planDate({ pro: false })).toBeNull();
    expect(planDate({ pro: true, standing: "live", at: DEC_3 })).toMatch(/^Renews /);
    expect(planDate({ pro: true, standing: "ending", at: DEC_3 })).toMatch(/^Ends /);
    expect(planDate({ pro: true, standing: "grace", at: DEC_3 })).toMatch(/^Payment failed\. Pro until .+\.$/);
  });

  it("names what the hours are made of", () => {
    expect(hoursDetail({ leftSeconds: 50 * 3600, monthly: { grantedSeconds: 100 * 3600, leftSeconds: 41 * 3600, resetsAt: DEC_3 }, packsLeftSeconds: 9 * 3600 })).toMatch(
      /^41 h of 100 h this month, resets .+, 9 h bought$/,
    );
    expect(hoursDetail({ leftSeconds: 3600, monthly: null, packsLeftSeconds: 3600 })).toBe("1 h bought");
  });

  it("takes initials from the first and last names", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("grace")).toBe("G");
    expect(initials("Mary Ann Evans")).toBe("ME");
  });
});
