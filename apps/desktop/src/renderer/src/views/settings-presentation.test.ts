import { describe, expect, it } from "vitest";
import { directSlackStatus, learningStatus, relayClientStatus, settingsTabIndex, textGenerationStatus, usageReportStatus } from "./settings-presentation";

describe("Settings decision priority", () => {
  it("keeps refresh failure visible during a retry and stale reports ahead of exhausted limits", () => {
    const state = { error: true, fetching: true, report: { status: "available" as const }, stale: true, exhausted: true };
    expect(usageReportStatus(state)).toBe("Refresh failed");
    expect(usageReportStatus({ ...state, error: false })).toBe("Refreshing…");
    expect(usageReportStatus({ ...state, error: false, fetching: false })).toBe("Stale report");
    expect(usageReportStatus({ ...state, error: false, fetching: false, report: { status: "disconnected" } })).toBe("Disconnected");
  });
  it("retains the different disconnected error wording of personal and relay Slack", () => {
    const connection = { connected: false, enabled: true, error: "Could not connect", busy: true };
    expect(directSlackStatus(connection)).toBe("Needs attention");
    expect(relayClientStatus(connection)).toBe("Reconnecting…");
    expect(directSlackStatus({ ...connection, connected: true })).toBe("Delivery pending");
    expect(relayClientStatus({ ...connection, connected: true })).toBe("Delivery pending");
  });
  it("reports unsaved text-generation choices before describing their fallback", () => {
    expect(textGenerationStatus({ loading: false, status: "error", value: { provider: "off" } })).toBe("Your selection has not been saved yet.");
    expect(textGenerationStatus({ loading: false, status: "saving", value: { provider: "auto" } })).toBe("Updating model…");
  });
  it("keeps memory loading and unavailable controls ahead of the disabled state", () => {
    const input = { loading: true, error: true, saved: null, provider: "off" as const, storageError: null, reason: null };
    expect(learningStatus(input)).toBe("Checking available providers…");
    expect(learningStatus({ ...input, loading: false })).toBe("Learning controls are unavailable until your memory settings load.");
  });
  it("wraps tab arrows while leaving unhandled keys alone", () => {
    expect(settingsTabIndex("ArrowLeft", 0, 4)).toBe(3);
    expect(settingsTabIndex("ArrowRight", 3, 4)).toBe(0);
    expect(settingsTabIndex("Enter", 1, 4)).toBeNull();
  });
});
