import type { WorkspaceMode } from "@openorc/protocol";

export function teamMoveBlockedReason(input: {
  loadFailed: boolean;
  loading: boolean;
  available: boolean;
  move?: { allowed: boolean; reason?: string | null };
  hasRecovery: boolean;
  savedError: string | null;
  hasPending: boolean;
}): string | null {
  if (input.loadFailed) return "Could not check the team workspace. Refresh team status to retry.";
  if (input.loading) return "Checking team workspace…";
  if (!input.available) return "This team workspace is unavailable. Refresh team status to retry.";
  if (!input.move) return "Team move availability is missing. Refresh team status to retry.";
  if (!input.hasRecovery && input.savedError) return input.savedError;
  if (input.hasPending || input.move.allowed) return null;
  return input.move.reason ?? "Move is currently unavailable for this team.";
}

export function teamMoveTitle({ notice, cancelling, pending, to }: { notice: string | null; cancelling: boolean; pending: boolean; to: WorkspaceMode | null }): string {
  if (notice) return "Workspace move confirmed";
  if (cancelling) return "Confirm move cancellation";
  if (pending) return "Confirm the saved move";
  if (!to) return "Move team workspace";
  return to === "current" ? "Move this team to the checkout?" : "Move this team to a worktree?";
}

export function teamMoveButton({ cancelPending, movePending, cancelling, pending }: { cancelPending: boolean; movePending: boolean; cancelling: boolean; pending: boolean }): string {
  if (cancelPending) return "Cancelling…";
  if (movePending) return "Moving…";
  if (cancelling) return "Retry cancellation";
  return pending ? "Retry move" : "Move";
}

export function threadForkLabel({ working, retry }: { working: boolean; retry: boolean }): string {
  if (working) return "Forking…";
  return retry ? "Retry fork" : "Fork";
}

export function threadMoveLabel({ cancelling, pending, mode }: { cancelling: boolean; pending: boolean; mode: WorkspaceMode }): string {
  if (cancelling) return "Retry move cancellation";
  if (pending) return "Retry move";
  return mode === "worktree" ? "Move to the checkout" : "Move to a worktree";
}

export function threadDeletionDescription({ team, tasks }: { team: boolean; tasks: number }): string {
  if (!team) return "The conversation is removed, and its worktree with it. Tasks it created stay, with their worktrees and branches.";
  if (tasks > 0)
    return `This conversation disappears from your lists. Its ${tasks} saved task${tasks === 1 ? " keeps" : "s keep"} the team, ${tasks === 1 ? "its" : "their"} activity, history and workspaces. Continue from ${tasks === 1 ? "the task’s" : "a task’s"} Activity tab.`;
  return "The conversation, its team activity and its isolated team workspaces are removed. Files in your project checkout are not touched.";
}

export function threadDeleteBlockedReason(input: { loading: boolean; exists: boolean; teamLoading: boolean; savedError: string | null }): string | null {
  if (input.loading) return "Checking this thread…";
  if (!input.exists) return "This thread no longer exists.";
  if (input.teamLoading) return "Checking team status…";
  return input.savedError || null;
}

export function deleteButtonLabel({ working, pending, count = 1 }: { working: boolean; pending: boolean; count?: number }): string {
  if (working) return "Deleting…";
  if (pending) return "Retry delete";
  return count === 1 ? "Delete" : `Delete ${count} tasks`;
}

export function teamTaskSubmitLabel({ working, pending, kind }: { working: boolean; pending: boolean; kind: "start" | "review" | "retry" }): string {
  if (working) return "Submitting…";
  if (kind === "start") return pending ? "Retry start request" : "Start task";
  if (pending) return "Retry saved request";
  return kind === "review" ? "Retry review" : "Retry task";
}
