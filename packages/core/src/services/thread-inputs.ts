import { redact, type Db } from "@openorc/db";
import type { AgentKind, PermissionPreset, RunMode, TaskPriority, WorkspaceMode } from "@openorc/protocol";
import { leadingText } from "./notice-text.js";
import { startingAccount, type AccountSource } from "./project-claude-accounts.js";

export interface StartThreadInput {
  /** The id its owner chose, as the cloud brain's Mac does; a new one unless given. */
  id?: string;
  claudeAccountId?: string;
  /**
   * Where claudeAccountId came from, when the project uses only some accounts: a person's choice, refused when it is not
   * one of them (the default); a parent's, a task's or a schedule's, which gives way to the project's default; or the
   * starter's own, as an Orcling's, left alone.
   */
  claudeAccountFrom?: AccountSource;
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
  /** A worktree prepared elsewhere that the conversation adopts: a pull request checked out detached, or its parent's on its branch. */
  checkout?: { path: string; baseSha: string; branch?: string };
  /** Runs the agent in a cloud sandbox; the conversation's worktree on the Mac mirrors it. */
  cloud?: boolean;
}

/**
 * The Claude account a start runs on in its project (see startingAccount). Only a Claude thread's account is a choice;
 * any other agent's goes along unseen, so one the project does not use gives way quietly, and a project with none of
 * its accounts enabled still starts it.
 */
export function startAccount(db: Db, input: Pick<StartThreadInput, "projectId" | "claudeAccountId" | "claudeAccountFrom" | "agent">): string {
  const from = input.agent === "claude" || input.claudeAccountFrom === "own" ? input.claudeAccountFrom : "unused";
  return startingAccount(db, input.projectId, input.claudeAccountId, from);
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
