import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_RELEASE, compareVersions, readWhatsNewSeen, whatsNewDue, writeWhatsNewSeen } from "./whats-new";

beforeEach(() => {
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) });
});

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
    expect(compareVersions("dev", CLOUD_RELEASE)).toBeNull();
    expect(compareVersions("1.0", CLOUD_RELEASE)).toBeNull();
  });
});

describe("whatsNewDue", () => {
  it("is due once after updating to the release with OpenOrc Cloud, or any later one", () => {
    expect(whatsNewDue({ running: CLOUD_RELEASE, seen: "0.1.0-beta.34", onboarded: true })).toBe(true);
    expect(whatsNewDue({ running: "0.2.0", seen: "0.1.0-beta.34", onboarded: true })).toBe(true);
  });

  it("is due to a profile from before versions were kept, once it finished onboarding", () => {
    expect(whatsNewDue({ running: CLOUD_RELEASE, seen: null, onboarded: true })).toBe(true);
    expect(whatsNewDue({ running: CLOUD_RELEASE, seen: null, onboarded: false })).toBe(false);
  });

  it("is not due again once settled for the release with OpenOrc Cloud or later", () => {
    expect(whatsNewDue({ running: "0.2.0", seen: CLOUD_RELEASE, onboarded: true })).toBe(false);
    expect(whatsNewDue({ running: "0.2.0", seen: "0.1.5", onboarded: true })).toBe(false);
  });

  it("is never due on a version before OpenOrc Cloud or one it cannot read", () => {
    expect(whatsNewDue({ running: "0.1.0-beta.34", seen: null, onboarded: true })).toBe(false);
    expect(whatsNewDue({ running: "dev", seen: null, onboarded: true })).toBe(false);
    expect(whatsNewDue({ running: CLOUD_RELEASE, seen: "dev", onboarded: true })).toBe(false);
  });
});

it("remembers the version the steps were settled for", () => {
  expect(readWhatsNewSeen()).toBeNull();
  writeWhatsNewSeen(CLOUD_RELEASE);
  expect(readWhatsNewSeen()).toBe(CLOUD_RELEASE);
  localStorage.setItem("openorc.whatsNew", "{broken");
  expect(readWhatsNewSeen()).toBeNull();
});
