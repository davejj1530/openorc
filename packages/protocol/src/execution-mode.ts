import { z } from "zod";
import type { PermissionPreset, RunMode } from "./domain.js";
import type { AgentKind } from "./events.js";

/** Public modes; the legacy pair remains the persisted wire representation. */
export const ExecutionMode = z.enum(["plan", "review", "trusted", "autonomous"]);
export type ExecutionMode = z.infer<typeof ExecutionMode>;
export const executionModeLabel: Record<ExecutionMode, string> = {
  plan: "Plan",
  review: "Review everything",
  trusted: "Accept edits",
  autonomous: "Autonomous",
};
export const executionModeHint: Record<ExecutionMode, string> = {
  plan: "Read-only, proposes a plan",
  review: "Asks before every command or edit",
  trusted: "Edits files, asks before commands",
  autonomous: "Runs tools without asking",
};
export function executionMode(mode: RunMode, permission: PermissionPreset): ExecutionMode {
  return mode === "plan" ? "plan" : permission;
}
export function executionModeSettings(mode: ExecutionMode): { mode: RunMode; permissionMode: PermissionPreset } {
  return { mode: mode === "plan" ? "plan" : "act", permissionMode: mode === "plan" ? "review" : mode };
}
export function stricterPermission(a: PermissionPreset, b: PermissionPreset): PermissionPreset {
  const rank = { review: 0, trusted: 1, autonomous: 2 };
  return rank[a] <= rank[b] ? a : b;
}
/** Describe the selected provider's actual policy, not a universal approval promise. */
export function executionModePresentation(agent: AgentKind | undefined, mode: ExecutionMode): { label: string; hint: string } {
  if (agent === "codex" && mode !== "plan") {
    return {
      review: { label: "Review changes", hint: "Read-only, asks before changes" },
      trusted: { label: "Ask for approval", hint: "Asks only outside the sandbox" },
      autonomous: { label: "Full access", hint: "No sandbox, no approval prompts" },
    }[mode];
  }
  return { label: executionModeLabel[mode], hint: executionModeHint[mode] };
}

/** OpenCode offers only Plan and Autonomous, since this integration cannot make it ask before each command. */
export function executionModeAvailable(agent: AgentKind | undefined, mode: ExecutionMode): boolean {
  return !((agent === "opencode" || agent === "acp") && (mode === "review" || mode === "trusted"));
}

export function executionModeUnavailable(agent: AgentKind, mode: ExecutionMode): string | null {
  if (executionModeAvailable(agent, mode)) return null;
  return `OpenCode cannot currently guarantee approval before every command through this integration. Choose Claude for ${executionModeLabel[mode]}, or explicitly choose another mode.`;
}

export interface ConversationPlan {
  id: string;
  threadId: string;
  runId: string;
  revision: number;
  text: string;
  state: "draft" | "ready" | "interrupted";
  source: "native" | "response";
  updatedAt: number;
}
