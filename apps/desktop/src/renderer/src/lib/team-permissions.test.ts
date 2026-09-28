import { describe, expect, it } from "vitest";
import type { TeamPermissionState } from "@openorc/protocol";
import { teamModeCounts, teamModeStatus, teamModeStatusText, teamPermissionCounts, teamPermissionStatus, teamPermissionStatusText, teamPolicyControlReason } from "./team-permissions";

function state(): TeamPermissionState {
  return {
    requested: "autonomous",
    effective: "autonomous",
    pendingRestart: false,
    runs: [{ runId: "lead", mode: "act", requested: "autonomous", effective: "autonomous", providerPermissionMode: "autonomous", pendingRestart: false }],
  };
}

describe("requested and effective team permissions", () => {
  it("does not present a selected restriction as applied while saving or waiting for the runtime cache", () => {
    expect(teamPermissionStatus({ state: state(), requested: "review", mode: "act", active: true, saving: true })).toBe("saving");
    expect(teamPermissionStatus({ state: state(), requested: "review", mode: "act", active: true, saving: false })).toBe("checking");
    expect(teamPermissionStatus({ state: state(), requested: "review", mode: "act", active: true, saving: false, failed: true })).toBe("unconfirmed");
    expect(teamPermissionCounts(state())).toEqual([{ permission: "autonomous", count: 1 }]);
    expect(teamPermissionStatus({ state: undefined, requested: "review", mode: "act", active: true, saving: false })).toBe("checking");
  });

  it("reports a native tightening as pending until the current writer finishes", () => {
    const pending: TeamPermissionState = { ...state(), requested: "review", pendingRestart: true, runs: state().runs.map((run) => ({ ...run, requested: "review", pendingRestart: true })) };
    expect(teamPermissionStatus({ state: pending, requested: "review", mode: "act", active: true, saving: false })).toBe("pending");
    expect(teamPermissionCounts(pending)).toEqual([{ permission: "autonomous", count: 1 }]);
    expect(teamPermissionStatus({ state: { requested: "review", effective: "review", pendingRestart: false, runs: [] }, requested: "review", mode: "act", active: false, saving: false })).toBe("next");
  });

  it("keeps checking through A→B→A until a post-save report reveals a writer started under B", () => {
    const oldA: TeamPermissionState = {
      requested: "review",
      effective: "review",
      pendingRestart: false,
      runs: [{ ...state().runs[0]!, requested: "review", effective: "review", providerPermissionMode: "review" }],
    };
    // The selected request is Review again, but this cached Review report
    // predates a new Autonomous worker. Equal requested values prove nothing.
    expect(teamPermissionStatus({ state: oldA, requested: "review", mode: "act", active: true, saving: false, refreshing: true })).toBe("checking");
    const afterSave: TeamPermissionState = {
      ...oldA,
      effective: null,
      pendingRestart: true,
      runs: [...oldA.runs, { ...state().runs[0]!, runId: "new-worker", requested: "review", pendingRestart: true }],
    };
    expect(teamPermissionStatus({ state: afterSave, requested: "review", mode: "act", active: true, saving: false })).toBe("pending");
    expect(teamPermissionCounts(afterSave)).toEqual([
      { permission: "review", count: 1 },
      { permission: "autonomous", count: 1 },
    ]);
  });

  it("explains Plan's effective review policy even when the selected Act preset is autonomous", () => {
    const plan: TeamPermissionState = {
      requested: "autonomous",
      effective: "review",
      pendingRestart: false,
      runs: [{ ...state().runs[0]!, mode: "plan", effective: "review", providerPermissionMode: "review" }],
    };
    expect(teamPermissionStatus({ state: plan, requested: "autonomous", mode: "plan", active: true, saving: false })).toBe("plan");
    expect(teamPermissionCounts(plan)).toEqual([{ permission: "review", count: 1 }]);
    // A mode change racing an execution may be rejected and remain selected
    // locally. Its current writer still has the reported Act permissions.
    expect(teamPermissionStatus({ state: state(), requested: "autonomous", mode: "plan", active: true, saving: false })).toBe("current");
  });

  it("retains every mixed writer's actual policy and handles a cached projection without policy metadata", () => {
    const mixed: TeamPermissionState = { ...state(), effective: null, runs: [...state().runs, { ...state().runs[0]!, runId: "worker", effective: "trusted", providerPermissionMode: "trusted" }] };
    expect(teamPermissionStatus({ state: mixed, requested: "autonomous", mode: "act", active: true, saving: false })).toBe("mixed");
    expect(teamPermissionCounts(mixed)).toEqual([
      { permission: "autonomous", count: 1 },
      { permission: "trusted", count: 1 },
    ]);
    expect(teamPermissionStatus({ state: undefined, requested: "trusted", mode: "act", active: false, saving: false })).toBe("next");
    expect(teamPermissionCounts(undefined)).toEqual([]);
  });
});

describe("requested and actual team modes", () => {
  const act = (): TeamPermissionState => ({ ...state(), mode: { requested: "act", effective: "act", pending: false } });

  it("keeps a running Act writer visible when Plan is requested, including failed saves", () => {
    expect(teamModeStatus({ state: act(), requested: "plan", active: true, saving: true })).toBe("saving");
    expect(teamModeStatus({ state: act(), requested: "plan", active: true, saving: false })).toBe("checking");
    expect(teamModeStatus({ state: act(), requested: "plan", active: true, saving: false, failed: true })).toBe("unconfirmed");
    const pending: TeamPermissionState = { ...act(), mode: { requested: "plan", effective: "act", pending: true }, pendingRestart: true };
    expect(teamModeStatus({ state: pending, requested: "plan", active: true, saving: false })).toBe("pending");
    expect(teamModeCounts(pending)).toEqual([{ mode: "act", count: 1 }]);
    expect(teamPermissionStatus({ state: pending, requested: "autonomous", mode: "plan", active: true, saving: false })).toBe("pending");
    expect(teamPermissionCounts(pending)).toEqual([{ permission: "autonomous", count: 1 }]);
  });

  it("does not accept an old Act report during Act→Plan→Act until the post-save read finishes", () => {
    expect(teamModeStatus({ state: act(), requested: "act", active: true, saving: false, refreshing: true })).toBe("checking");
    expect(teamPermissionStatus({ state: act(), requested: "autonomous", mode: "act", active: true, saving: false, refreshing: true })).toBe("checking");
    const mixed: TeamPermissionState = {
      ...act(),
      mode: { requested: "act", effective: null, pending: true },
      effective: null,
      runs: [...act().runs, { ...state().runs[0]!, runId: "plan-worker", mode: "plan", effective: "review", providerPermissionMode: "review" }],
    };
    expect(teamModeStatus({ state: mixed, requested: "act", active: true, saving: false })).toBe("mixed");
    expect(teamModeCounts(mixed)).toEqual([
      { mode: "plan", count: 1 },
      { mode: "act", count: 1 },
    ]);
    expect(teamPermissionStatus({ state: mixed, requested: "autonomous", mode: "act", active: true, saving: false })).toBe("mixed");
  });

  it("waits for optional old-cache mode metadata during execution and handles fully applied idle policy", () => {
    expect(teamModeStatus({ state: state(), requested: "act", active: true, saving: false })).toBe("checking");
    expect(teamModeStatus({ state: undefined, requested: "act", active: true, saving: false })).toBe("checking");
    expect(teamModeStatus({ state: undefined, requested: "plan", active: false, saving: false })).toBe("next");
    const idle: TeamPermissionState = { requested: "trusted", effective: "trusted", pendingRestart: false, runs: [], mode: { requested: "plan", effective: "plan", pending: false } };
    expect(teamModeStatus({ state: idle, requested: "plan", active: false, saving: false })).toBe("next");
    expect(teamModeCounts(idle)).toEqual([]);
    expect(teamModeStatus({ state: act(), requested: "act", active: true, saving: false })).toBe("current");
    expect(teamPermissionStatus({ state: act(), requested: "autonomous", mode: "plan", active: true, saving: false })).toBe("checking");
  });
});

it("keeps the exact wording for requested policy and reported writer status", () => {
  const input = { selected: "Workspace access", nextPermission: "Review", current: "Review, Autonomous" };
  expect(teamPermissionStatusText({ ...input, kind: "saving" })).toBe("Saving Workspace access permissions… Last reported: Review, Autonomous.");
  expect(teamPermissionStatusText({ ...input, kind: "unconfirmed" })).toBe("Workspace access is selected; its save is unconfirmed. Last reported: Review, Autonomous.");
  expect(teamPermissionStatusText({ ...input, kind: "checking" })).toBe("Requested Workspace access. Checking current agent permissions… Last reported: Review, Autonomous.");
  expect(teamPermissionStatusText({ ...input, kind: "plan" })).toBe("Plan blocks project changes and external writes. Workspace access is selected for implementation.");
  expect(teamPermissionStatusText({ ...input, kind: "pending" })).toBe("Review applies after current agents finish. Current agents: Review, Autonomous.");
  expect(teamPermissionStatusText({ ...input, kind: "mixed" })).toBe("Current agents: Review, Autonomous. Requested Workspace access.");
  expect(teamPermissionStatusText({ ...input, kind: "current" })).toBe("Current agents use Review, Autonomous.");
  expect(teamPermissionStatusText({ ...input, kind: "next" })).toBe("New agents will use Workspace access.");
  expect(teamPermissionStatusText({ ...input, kind: "pending", current: "" })).toBe("Review applies after current agents finish.");
});

it("keeps the exact wording for requested mode and reported writer modes", () => {
  const input = { selected: "Plan", current: "Act" };
  expect(teamModeStatusText({ ...input, kind: "saving" })).toBe("Saving Plan mode… Last reported: Act.");
  expect(teamModeStatusText({ ...input, kind: "unconfirmed" })).toBe("Plan is selected; its save is unconfirmed. Last reported: Act.");
  expect(teamModeStatusText({ ...input, kind: "checking" })).toBe("Requested Plan. Checking current agent modes… Last reported: Act.");
  expect(teamModeStatusText({ ...input, kind: "pending" })).toBe("Plan is selected for new turns. Current agents are still in Act.");
  expect(teamModeStatusText({ ...input, kind: "mixed" })).toBe("Requested Plan. Current agents: Act.");
  expect(teamModeStatusText({ ...input, kind: "current" })).toBe("Current agents are in Act.");
  expect(teamModeStatusText({ ...input, kind: "next" })).toBe("New turns will use Plan.");
});

it("gives failed saves priority over a missing or stale policy report", () => {
  const mode = { control: "mode" as const, saveFailed: false, refreshFailed: false, reportMissing: false };
  const permission = { ...mode, control: "permission" as const };
  expect(teamPolicyControlReason({ ...mode, saveFailed: true, refreshFailed: true, reportMissing: true })).toBe("Retry or reset the selected mode and permissions first.");
  expect(teamPolicyControlReason({ ...mode, reportMissing: true })).toBe("Refresh team activity to check current modes.");
  expect(teamPolicyControlReason(mode)).toBe("Saving mode and permissions…");
  expect(teamPolicyControlReason({ ...permission, saveFailed: true, refreshFailed: true })).toBe("Retry or reset the selected permissions first.");
  expect(teamPolicyControlReason({ ...permission, refreshFailed: true })).toBe("Refresh team activity to check current permissions.");
  expect(teamPolicyControlReason(permission)).toBe("Saving permissions…");
});
