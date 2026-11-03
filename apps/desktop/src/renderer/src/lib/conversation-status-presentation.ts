import { WORKSPACE_ID, type Project, type WorkspaceMode } from "@openorc/protocol";
import type { ConversationScope } from "../components/Conversation";

export function conversationWorkspaceMode({ scope, firstTaskRun, selected }: { scope: ConversationScope; firstTaskRun: boolean; selected: WorkspaceMode | null }): WorkspaceMode {
  if (scope.kind === "thread") return scope.thread.workspaceMode;
  if (firstTaskRun && !scope.task.worktreePath) return selected ?? scope.task.workspaceMode;
  return scope.task.workspaceMode;
}

export function conversationLocation({
  scope,
  project,
  mode,
  basePath,
  checkoutBranch,
  plainFolder = false,
}: {
  scope: ConversationScope;
  project: Project;
  mode: WorkspaceMode;
  basePath: string;
  checkoutBranch: string | null | undefined;
  /** A project folder without git has no checkout to name, only the folder. */
  plainFolder?: boolean;
}) {
  if (project.id === WORKSPACE_ID || plainFolder) return { label: null, branch: null, directory: basePath };
  if (scope.kind === "task")
    return { label: mode === "worktree" ? "Worktree" : "Local checkout", branch: mode === "current" ? (scope.task.branch ?? project.defaultBranch) : scope.task.branch, directory: basePath };
  if (scope.thread.cloud) return { label: "Cloud", branch: scope.thread.branch, directory: basePath, cloud: true };
  if (scope.thread.workspaceMode === "worktree") return { label: "Worktree", branch: scope.thread.branch, directory: basePath };
  return { label: "Local checkout", branch: checkoutBranch ?? null, directory: basePath };
}

export function conversationEmptyHint({ task, workspace }: { task: boolean; workspace: boolean }): string {
  if (task) return "Your task description is included. Add any direction below, or send to start.";
  if (workspace) return "Continue the conversation. The agent works in the folder shown below.";
  return "Say what you want. The agent works in the project root and can delegate isolated changes to tasks.";
}

export function conversationEmptyTitle({ count, firstTaskRun }: { count: number; firstTaskRun: boolean }): string {
  if (count !== 0) return "Loading transcript";
  return firstTaskRun ? "What would you like to work on?" : "Nothing yet";
}

export function workspaceDestination({ mode, rootPath, taskPath }: { mode: WorkspaceMode; rootPath: string; taskPath: string | null }): string {
  if (mode === "current") return rootPath;
  return taskPath || "A new isolated worktree will be created on send.";
}
