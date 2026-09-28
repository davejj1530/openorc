import type { TeamActionAvailability } from "@openorc/protocol";

const THREAD_ACTION_REASONS = {
  moveLoadFailed: "Could not check team move availability. Refresh team status to retry.",
  moveLoading: "Checking team move availability…",
  moveMissing: "Team move availability is missing. Refresh team status to retry.",
  moveUnavailable: "Move is currently unavailable for this team.",
  deleteLoadFailed: "Could not check team delete availability. Refresh team status to retry.",
  deleteLoading: "Checking team delete availability…",
  deleteMissing: "Team delete availability is missing. Refresh team status to retry.",
  deleteUnavailable: "Delete is currently unavailable for this team.",
  activityLoadFailed: "Could not check team activity. Retry before organizing this task.",
  activityLoading: "Checking team activity…",
  executionOpen: "Finish or stop this team execution before archiving or snoozing.",
  publicationPending: "Resolve the retained integration details before archiving or snoozing.",
} as const;

interface TeamActionRead {
  team: boolean;
  loadFailed: boolean;
  loaded: boolean;
}

export interface TeamMoveReasonInput extends TeamActionRead {
  availability?: TeamActionAvailability;
  hasRecovery: boolean;
  savedError: string | null;
  hasPendingRequest: boolean;
}

export function teamMoveReason(input: TeamMoveReasonInput): string | null {
  if (!input.team) return null;
  if (input.loadFailed) return THREAD_ACTION_REASONS.moveLoadFailed;
  if (!input.loaded) return THREAD_ACTION_REASONS.moveLoading;
  if (!input.availability) return THREAD_ACTION_REASONS.moveMissing;
  if (!input.hasRecovery && input.savedError) return input.savedError;
  if (input.hasPendingRequest || input.availability.allowed) return null;
  return input.availability.reason ?? THREAD_ACTION_REASONS.moveUnavailable;
}

export interface TeamDeleteReasonInput extends TeamActionRead {
  availability?: TeamActionAvailability;
  hasRecovery: boolean;
  savedError: string | null;
  hasPendingRequest: boolean;
}

export function teamDeleteReason(input: TeamDeleteReasonInput): string | null {
  if (!input.team) return null;
  if (input.loadFailed) return THREAD_ACTION_REASONS.deleteLoadFailed;
  if (!input.loaded) return THREAD_ACTION_REASONS.deleteLoading;
  if (input.hasRecovery) return null;
  if (!input.availability) return THREAD_ACTION_REASONS.deleteMissing;
  if (input.savedError) return input.savedError;
  if (input.hasPendingRequest || input.availability.allowed) return null;
  return input.availability.reason ?? THREAD_ACTION_REASONS.deleteUnavailable;
}

export interface TeamLifecycleReasonInput extends TeamActionRead {
  hasOpenExecution: boolean;
  hasPendingPublication: boolean;
}

export function teamLifecycleReason(input: TeamLifecycleReasonInput): string | null {
  if (!input.team) return null;
  if (input.loadFailed) return THREAD_ACTION_REASONS.activityLoadFailed;
  if (!input.loaded) return THREAD_ACTION_REASONS.activityLoading;
  if (input.hasOpenExecution) return THREAD_ACTION_REASONS.executionOpen;
  if (input.hasPendingPublication) return THREAD_ACTION_REASONS.publicationPending;
  return null;
}
