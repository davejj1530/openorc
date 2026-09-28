import type { TeamConversation, TeamRetainedTaskRuntime } from "@openorc/protocol";

/** A retained owner is read and controlled through one of its surviving tasks. */
export const teamTaskScope = (taskId?: string) => (taskId ? { taskId } : {});

export function teamControlParams(threadId: string, taskId?: string) {
  return { threadId, ...teamTaskScope(taskId) };
}

export function teamRuntimeQueryKey(threadId: string, taskId?: string) {
  return taskId ? (["orchestration.taskRuntime", { taskId }] as const) : (["orchestration.runtime", { threadId }] as const);
}

/** Both runtime queries cache the same conversation shape under different wrappers. */
export function teamRuntimeData(cached: TeamConversation | TeamRetainedTaskRuntime | null | undefined): TeamConversation | undefined {
  if (!cached) return undefined;
  return "runtime" in cached ? cached.runtime : cached;
}
