import { describe, expect, it } from "vitest";
import { compareVersions, whatsNewDue } from "./whats-new.js";

const RELEASE = "0.1.0-beta.35";

describe("compareVersions", () => {
  it("orders releases and betas, a beta before its release", () => {
    expect(compareVersions("0.1.0-beta.34", "0.1.0-beta.35")).toBeLessThan(0);
    expect(compareVersions("0.1.0-beta.40", "0.1.0-beta.35")).toBeGreaterThan(0);
    expect(compareVersions("0.1.0", "0.1.0-beta.35")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0-beta.1", "0.1.0")).toBeGreaterThan(0);
    expect(compareVersions("0.1.0-beta.10", "0.1.0-beta.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("reads no order into a version it does not know", () => {
    expect(compareVersions("dev", RELEASE)).toBeNull();
    expect(compareVersions("1.0", RELEASE)).toBeNull();
  });
});

describe("whatsNewDue", () => {
  it("is due once after updating to the release with OpenOrc Cloud, or any later one", () => {
    expect(whatsNewDue({ release: RELEASE, running: RELEASE, seen: "0.1.0-beta.34", onboarded: true })).toBe(true);
    expect(whatsNewDue({ release: RELEASE, running: "0.2.0", seen: "0.1.0-beta.34", onboarded: true })).toBe(true);
  });

  it("is due to a profile from before versions were kept, once it finished onboarding", () => {
    expect(whatsNewDue({ release: RELEASE, running: RELEASE, seen: null, onboarded: true })).toBe(true);
    expect(whatsNewDue({ release: RELEASE, running: RELEASE, seen: null, onboarded: false })).toBe(false);
  });

  it("is not due again once settled for the release with OpenOrc Cloud or later", () => {
    expect(whatsNewDue({ release: RELEASE, running: "0.2.0", seen: RELEASE, onboarded: true })).toBe(false);
    expect(whatsNewDue({ release: RELEASE, running: "0.2.0", seen: "0.1.5", onboarded: true })).toBe(false);
  });

  it("is never due on a version before OpenOrc Cloud or one it cannot read", () => {
    expect(whatsNewDue({ release: RELEASE, running: "0.1.0-beta.34", seen: null, onboarded: true })).toBe(false);
    expect(whatsNewDue({ release: RELEASE, running: "dev", seen: null, onboarded: true })).toBe(false);
    expect(whatsNewDue({ release: RELEASE, running: RELEASE, seen: "dev", onboarded: true })).toBe(false);
  });
});
