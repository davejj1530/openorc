const SEND_DISABLED_REASONS = {
  retainedButInactive: "This conversation was deleted. Start or review the saved task to continue.",
  archived: "Unarchive this task from its menu before sending.",
  refreshFailed: "Refresh team activity before sending.",
  stopping: "Wait for the team to stop.",
  checkingAvailability: "Checking team availability…",
} as const;

export interface TeamSendAvailability {
  retained: boolean;
  active: boolean;
  archived: boolean;
  refreshFailed: boolean;
  stopping: boolean;
  teamEnabled: boolean;
  availabilityReason?: string | null;
}

/** Earlier conditions win when a retained or stopping conversation also has stale availability. */
export function teamSendDisabledReason(input: TeamSendAvailability): string | null {
  if (input.retained && !input.active) return SEND_DISABLED_REASONS.retainedButInactive;
  if (input.archived && !input.retained) return SEND_DISABLED_REASONS.archived;
  if (input.refreshFailed) return SEND_DISABLED_REASONS.refreshFailed;
  if (input.stopping) return SEND_DISABLED_REASONS.stopping;
  if (!input.active && !input.teamEnabled) return input.availabilityReason ?? SEND_DISABLED_REASONS.checkingAvailability;
  return null;
}
