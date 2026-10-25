import { redact } from "@openorc/db";
import type { AgentKind, PermissionPreset, RunMode, TaskPriority, WorkspaceMode } from "@openorc/protocol";
import { leadingText } from "./notice-text.js";

export interface StartThreadInput {
  claudeAccountId?: string;
  projectId: string;
  workingDirectory?: string;
  agent: AgentKind;
  model: string | undefined;
  effort: string | undefined;
  fastMode?: boolean | undefined;
  mode: RunMode;
  permissionMode: PermissionPreset;
  workspaceMode?: WorkspaceMode;
  baseRef?: string;
  prompt: string;
  attachments: string[] | undefined;
  title: string | undefined;
  /** How the first message shows: what the user typed, or a system notice such as a scheduled prompt. */
  promptRole?: "user" | "system";
  /** A worktree prepared elsewhere that the conversation adopts, such as a pull request checked out detached. */
  checkout?: { path: string; baseSha: string };
}

/** Names a thread from its first exchange; null when no model is available. */
export type ThreadTitler = (exchange: { request: string; reply: string | null }, agent: AgentKind, claudeAccountId?: string) => Promise<string | null>;

export interface SpawnTaskInput {
  title: string;
  spec: string;
  priority?: TaskPriority;
  labels?: string[];
  execution?: "backlog" | "delegate";
  workspaceMode?: WorkspaceMode;
}

export interface ThreadPatch {
  title?: string;
  mode?: RunMode;
  permissionMode?: PermissionPreset;
  model?: string | null;
  effort?: string | null;
  fastMode?: boolean;
  agent?: AgentKind;
  archived?: boolean;
  pinned?: boolean;
  done?: boolean;
  snoozedUntil?: number | null;
  seen?: boolean;
  draft?: string | null;
  prUrl?: string | null;
}

/**
 * The first line of the prompt makes a fine title until the user renames the thread. Its secrets are masked before the
 * cut, which could otherwise leave part of a token no rule recognizes, in the thread's name and its notices.
 */
export function titleFromPrompt(prompt: string): string {
  const line =
    redact(prompt)
      .text.split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim() ?? "New thread";
  return leadingText(line, 72) === line ? line : `${leadingText(line, 71).trimEnd()}…`;
}
