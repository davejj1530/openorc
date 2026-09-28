import { existsSync } from "node:fs";
import { orchestration, projects, tasks, teamRuntime, teamWorkspaces, type Db } from "@openorc/db";
import type { TeamActionAvailability } from "@openorc/protocol";
import type { TeamCoordinator } from "./team-coordinator.js";
import type { TeamOperationGuard } from "./team-operations.js";

export type TeamTaskExport = TeamActionAvailability & { branch: string };
export const teamTaskBranch = (taskId: string) => `openorc/team-task-${taskId}`;
const text = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A team-owned task publishes its own assignment workspace on a dedicated branch.
 * Baseline is the assignment's captured input commit, which is what its Changes
 * tab already diffs against; inherited uncommitted input is therefore part of the
 * export and visible in that diff. Null when the task is not team-owned.
 */
export function teamTaskExportAvailability(db: Db, deps: { coordinator: TeamCoordinator; guard: TeamOperationGuard }, taskId: string): TeamTaskExport | null {
  const task = tasks.get(db, taskId);
  if (!task) return null;
  const bindings = teamRuntime.assignmentsForTask(db, taskId);
  if (!(task.threadId && orchestration.getInstance(db, task.threadId)) && !bindings.length) return null;
  const branch = teamTaskBranch(taskId);
  const deny = (reason: string): TeamTaskExport => ({ allowed: false, reason, branch });
  const binding = bindings.at(-1);
  if (!binding) return deny("This task has no assignment workspace to publish yet. Start it with its team first.");
  const record = teamWorkspaces.get(db, binding.executionId, binding.actorId);
  if (!record || record.state !== "ready" || record.setupState !== "completed") return deny("The team assignment workspace is not ready. Recover its setup before publishing.");
  if (!task.worktreePath || record.path !== task.worktreePath || !existsSync(record.path))
    return deny("The task's workspace pointer does not match its retained team assignment workspace. Preserve it for recovery.");
  if (record.path === projects.get(db, task.projectId)?.rootPath) return deny("Publish the local checkout from the team conversation.");
  if (task.branch && task.branch !== branch) return deny("This task's branch is not its team publication branch. Preserve that history before publishing here.");
  const execution = teamRuntime.get(db, binding.executionId);
  if (!execution) return deny("The assignment's execution journal is missing. Preserve the database for recovery.");
  try {
    deps.guard.assertAvailable(execution.threadId, undefined, { retainedTask: true });
  } catch (error) {
    return deny(text(error));
  }
  const busy = deps.coordinator.actorIdleReason(binding.executionId, binding.actorId);
  if (busy) return deny(busy);
  if (teamWorkspaces.publications(db, binding.executionId).some((receipt) => receipt.destinationPath === record.path && receipt.state !== "applied" && receipt.state !== "conflict"))
    return deny("An integration into this workspace is unfinished. Recover it before publishing the workspace.");
  return { allowed: true, reason: null, branch };
}
