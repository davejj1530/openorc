const EXECUTION_LOCATION_REASONS = {
  loadFailed: "Could not load execution settings. Retry to continue.",
  loading: "Checking execution location…",
  workspaceProject: "This task uses its conversation’s folder.",
  savedTeam: "This item is no longer available.",
  sharedConversation: "This task shares its execution conversation. Use the conversation menu to move its workspace.",
  activeAgent: "Stop the task’s existing agent in Activity before moving its workspace.",
  activeConversation: "Wait for the current turn to finish before moving this conversation.",
} as const;

export interface TaskExecutionAvailability {
  loadFailed: boolean;
  loading: boolean;
  workspaceProject: boolean;
  savedTeam: boolean;
  sharedConversation: boolean;
  activeAgent: boolean;
  activeConversation: boolean;
}

export function taskExecutionDisabledReason(input: TaskExecutionAvailability): string | null {
  if (input.loadFailed) return EXECUTION_LOCATION_REASONS.loadFailed;
  if (input.loading) return EXECUTION_LOCATION_REASONS.loading;
  if (input.workspaceProject) return EXECUTION_LOCATION_REASONS.workspaceProject;
  if (input.savedTeam) return EXECUTION_LOCATION_REASONS.savedTeam;
  if (input.sharedConversation) return EXECUTION_LOCATION_REASONS.sharedConversation;
  if (input.activeAgent) return EXECUTION_LOCATION_REASONS.activeAgent;
  if (input.activeConversation) return EXECUTION_LOCATION_REASONS.activeConversation;
  return null;
}
