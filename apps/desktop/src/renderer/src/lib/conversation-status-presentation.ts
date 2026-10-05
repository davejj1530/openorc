import { WORKSPACE_ID, defaultHarnessId, harnessShortName, type AgentKind, type Project, type Thread, type WorkspaceMode } from "@openorc/protocol";
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
  if (scope.thread.workspaceMode === "worktree") return { label: "Worktree", branch: scope.thread.branch, directory: basePath };
  return { label: "Local checkout", branch: checkoutBranch ?? null, directory: basePath };
}

export function conversationEmptyHint({ task, workspace }: { task: boolean; workspace: boolean }): string {
  if (task) return "Your task description is included. Add any direction below, or send to start.";
  if (workspace) return "Continue the conversation. The agent works in the folder shown below.";
  return "Say what you want. The agent works in the project root and can delegate isolated changes to tasks.";
}

export function conversationPlaceholder({ firstTaskRun, working, canSteer, agent }: { firstTaskRun: boolean; working: boolean; canSteer: boolean; agent: AgentKind | undefined }): string {
  if (firstTaskRun) return "Add direction, or send to start this task…";
  if (working) return canSteer ? "Say it during this turn…" : "Queue a message for when it finishes…";
  return `Message ${harnessShortName(agent ?? defaultHarnessId)}…`;
}

export function conversationEmptyTitle({ count, firstTaskRun }: { count: number; firstTaskRun: boolean }): string {
  if (count !== 0) return "Loading transcript";
  return firstTaskRun ? "What would you like to work on?" : "Nothing yet";
}

export function workspaceDestination({ mode, rootPath, taskPath }: { mode: WorkspaceMode; rootPath: string; taskPath: string | null }): string {
  if (mode === "current") return rootPath;
  return taskPath || "A new isolated worktree will be created on send.";
}

export function durableActionLabel({ working, pending, labels }: { working: boolean; pending: boolean; labels: readonly [idle: string, pending: string, working: string] }): string {
  if (working) return labels[2];
  return pending ? labels[1] : labels[0];
}

export function teamMessageHint({
  active,
  hasMembers,
  hasMention,
  canSteer,
  steerReason,
  mentionHint,
}: {
  active: boolean;
  hasMembers: boolean;
  hasMention: boolean;
  canSteer: boolean;
  steerReason: string | null | undefined;
  mentionHint: string;
}): string {
  if (active) return `Enter sends to the active turn where supported. Queue keeps it for the next turn. ${!hasMention && !canSteer ? (steerReason ?? "Waiting for delivery availability.") : ""}`;
  return hasMembers ? mentionHint : "The next message starts this saved team with its current files.";
}

export function teamAttentionLabel({ approval, question }: { approval: boolean; question: boolean }): string {
  if (!approval) return "Needs attention";
  return question ? "Question" : "Approval";
}

export function teamActorStateLabel({ pending, heldForPlan, stateLabel }: { pending: boolean; heldForPlan: boolean; stateLabel: string }): string {
  if (pending) return "Needs you";
  return heldForPlan ? "Waiting for Act" : stateLabel;
}

export function teamReplyForkDescription({ mutating, saved }: { mutating: boolean; saved: boolean }): string {
  if (mutating) return "Wait for the current task action to finish.";
  return saved ? "Confirm the saved fork from this lead turn." : "Create an independent team task with history and files through this lead turn.";
}

/** The team's composer names its actual working copy, including a custom folder. */
export function teamConversationLocation(thread: Thread, project: Project) {
  return { label: thread.workspaceMode === "current" ? "Local checkout" : "Worktree", branch: thread.branch, directory: thread.workingDirectory ?? thread.worktreePath ?? project.rootPath };
}
