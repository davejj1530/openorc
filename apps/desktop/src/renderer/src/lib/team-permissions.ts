import type { PermissionPreset, RunMode, TeamPermissionState } from "@openorc/protocol";

export type TeamPermissionStatusKind = "saving" | "unconfirmed" | "checking" | "plan" | "pending" | "mixed" | "current" | "next";
export type TeamModeStatusKind = Exclude<TeamPermissionStatusKind, "plan">;

const TEAM_CONTROL_REASONS = {
  modeFailed: "Retry or reset the selected mode and permissions first.",
  modeReportMissing: "Refresh team activity to check current modes.",
  modeSaving: "Saving mode and permissions…",
  permissionFailed: "Retry or reset the selected permissions first.",
  permissionReportMissing: "Refresh team activity to check current permissions.",
  permissionSaving: "Saving permissions…",
} as const;

export function teamPolicyControlReason({
  control,
  saveFailed,
  refreshFailed,
  reportMissing,
}: {
  control: "mode" | "permission";
  saveFailed: boolean;
  refreshFailed: boolean;
  reportMissing: boolean;
}): string {
  if (control === "mode") {
    if (saveFailed) return TEAM_CONTROL_REASONS.modeFailed;
    if (refreshFailed || reportMissing) return TEAM_CONTROL_REASONS.modeReportMissing;
    return TEAM_CONTROL_REASONS.modeSaving;
  }
  if (saveFailed) return TEAM_CONTROL_REASONS.permissionFailed;
  if (refreshFailed || reportMissing) return TEAM_CONTROL_REASONS.permissionReportMissing;
  return TEAM_CONTROL_REASONS.permissionSaving;
}

/** A requested mode never changes the mode of an already running process. */
export function teamModeStatus({
  state,
  requested,
  active,
  saving,
  failed = false,
  refreshing = false,
}: {
  state: TeamPermissionState | undefined;
  requested: RunMode;
  active: boolean;
  saving: boolean;
  failed?: boolean;
  refreshing?: boolean;
}): TeamModeStatusKind {
  if (saving) return "saving";
  if (failed) return "unconfirmed";
  if (refreshing) return "checking";
  if ((!state?.mode && active) || (state?.mode && state.mode.requested !== requested)) return "checking";
  if (state?.mode?.effective === null) return "mixed";
  if (state?.mode?.pending) return "pending";
  return state?.runs.length ? "current" : "next";
}

export function teamModeCounts(state: TeamPermissionState | undefined): { mode: RunMode; count: number }[] {
  return (["plan", "act"] as const).flatMap((mode) => {
    const count = state?.runs.filter((run) => run.mode === mode).length ?? 0;
    return count ? [{ mode, count }] : [];
  });
}

/** The selected preset is a request, never proof of an active provider's policy. */
export function teamPermissionStatus({
  state,
  requested,
  mode,
  active,
  saving,
  failed = false,
  refreshing = false,
}: {
  state: TeamPermissionState | undefined;
  requested: PermissionPreset;
  mode: RunMode;
  active: boolean;
  saving: boolean;
  failed?: boolean;
  refreshing?: boolean;
}): TeamPermissionStatusKind {
  if (saving) return "saving";
  if (failed) return "unconfirmed";
  if (refreshing) return "checking";
  if ((!state && active) || (state && state.requested !== requested) || (state?.mode && state.mode.requested !== mode)) return "checking";
  // A retained, failed mode selection must not relabel an existing Act writer.
  if (state?.runs.length ? state.runs.every((run) => run.mode === "plan") : mode === "plan") return "plan";
  if (state?.pendingRestart) return "pending";
  if (!state?.runs.length) return "next";
  return state.effective === null ? "mixed" : "current";
}

export function teamPermissionCounts(state: TeamPermissionState | undefined): { permission: PermissionPreset; count: number }[] {
  const counts = new Map<PermissionPreset, number>();
  for (const run of state?.runs ?? []) counts.set(run.effective, (counts.get(run.effective) ?? 0) + 1);
  return [...counts].map(([permission, count]) => ({ permission, count }));
}

/** The selected request and the running agents' reported policy are separate facts. */
export function teamPermissionStatusText({ kind, selected, nextPermission, current }: { kind: TeamPermissionStatusKind; selected: string; nextPermission: string; current: string }): string {
  const lastReported = current ? ` Last reported: ${current}.` : "";
  if (kind === "saving") return `Saving ${selected} permissions…${lastReported}`;
  if (kind === "unconfirmed") return `${selected} is selected; its save is unconfirmed.${lastReported}`;
  if (kind === "checking") return `Requested ${selected}. Checking current agent permissions…${lastReported}`;
  if (kind === "plan") return `Plan blocks project changes and external writes. ${selected} is selected for implementation.`;
  if (kind === "pending") return `${nextPermission} applies after current agents finish.${current ? ` Current agents: ${current}.` : ""}`;
  if (kind === "mixed") return `Current agents: ${current}. Requested ${selected}.`;
  if (kind === "current") return `Current agents use ${current}.`;
  return `New agents will use ${selected}.`;
}

export function teamModeStatusText({ kind, selected, current }: { kind: TeamModeStatusKind; selected: string; current: string }): string {
  const lastReported = current ? ` Last reported: ${current}.` : "";
  if (kind === "saving") return `Saving ${selected} mode…${lastReported}`;
  if (kind === "unconfirmed") return `${selected} is selected; its save is unconfirmed.${lastReported}`;
  if (kind === "checking") return `Requested ${selected}. Checking current agent modes…${lastReported}`;
  if (kind === "pending") return `${selected} is selected for new turns. Current agents are still in ${current}.`;
  if (kind === "mixed") return `Requested ${selected}. Current agents: ${current}.`;
  if (kind === "current") return `Current agents are in ${current}.`;
  return `New turns will use ${selected}.`;
}
