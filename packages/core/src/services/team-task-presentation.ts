import type { Task, TeamActorRecord, TeamTaskAdmissionView } from "@openorc/protocol";
export function routedAdmissionState(actor: TeamActorRecord | undefined): TeamTaskAdmissionView["state"] {
  if (actor?.state === "running" || actor?.state === "waiting") return "running";
  if (actor?.state === "starting") return "received";
  return "queued";
}
export function capturedTaskMessage(task: Pick<Task, "status">, duplicate: boolean): string {
  if (duplicate) return "This request already saved the task. Its current document and retained assignment intent are preserved.";
  if (task.status === "proposed") return "Task proposed with its team assignment and dependencies. No agent or worktree was started.";
  return "Saved to backlog with its team assignment and dependencies. No agent or worktree was started.";
}
