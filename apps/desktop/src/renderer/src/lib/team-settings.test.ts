import { describe, expect, it } from "vitest";
import type { ModelExecutionSettings } from "@openorc/protocol";
import { effectiveTeamLead, effectiveTeamPolicy } from "./team-settings";

describe("acknowledged team settings", () => {
  it("keeps acknowledged permissions through the stale-cache interval before the next mode change", () => {
    const cached = { mode: "plan", permissionMode: "trusted", updatedAt: 100 } as const;
    const receipt = { mode: "plan", permissionMode: "autonomous", updatedAt: 101 } as const;
    expect(effectiveTeamPolicy(cached, receipt)).toEqual({ mode: "plan", permissionMode: "autonomous" });
    expect({ ...effectiveTeamPolicy(cached, receipt), mode: "act" }).toEqual({ mode: "act", permissionMode: "autonomous" });
    expect(effectiveTeamPolicy({ ...cached, updatedAt: 101 }, receipt).permissionMode).toBe("autonomous");
    expect(effectiveTeamPolicy(receipt, receipt)).toEqual({ mode: "plan", permissionMode: "autonomous" });
    expect(effectiveTeamPolicy({ mode: "act", permissionMode: "review", updatedAt: 102 }, receipt)).toEqual({ mode: "act", permissionMode: "review" });
  });

  it("keeps accepted effort when Fast is changed before the instance cache catches up", () => {
    const saved: ModelExecutionSettings = { agent: "codex", model: "same-model", effort: "medium", fastMode: false };
    const receipt = { configurationVersion: 2, settings: { ...saved, effort: "high" } };
    const shown = effectiveTeamLead(saved, { configurationVersion: 1, leadOverrides: {} }, receipt);
    expect({ ...shown, fastMode: true }).toEqual({ ...saved, effort: "high", fastMode: true });
    expect(effectiveTeamLead(saved, { configurationVersion: 2, leadOverrides: { effort: "high" } }, receipt)).toEqual(receipt.settings);
    expect(effectiveTeamLead(saved, { configurationVersion: 3, leadOverrides: { effort: "low", fastMode: true } }, receipt)).toEqual({ ...saved, effort: "low", fastMode: true });
  });

  it("keeps the latest rapid mode acknowledgement when an earlier same-millisecond response arrives", () => {
    const earlier = { mode: "plan", permissionMode: "autonomous", updatedAt: 200 } as const;
    const latest = { mode: "act", permissionMode: "autonomous", updatedAt: 200 } as const;
    expect(effectiveTeamPolicy(earlier, latest)).toEqual({ mode: "act", permissionMode: "autonomous" });
    expect(effectiveTeamPolicy({ ...earlier, updatedAt: 199 }, latest)).toEqual({ mode: "act", permissionMode: "autonomous" });
    expect(effectiveTeamPolicy({ ...earlier, updatedAt: 201 }, latest)).toEqual({ mode: "plan", permissionMode: "autonomous" });
  });
});
