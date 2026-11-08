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
  if (agent === "fx" && mode !== "plan") {
    return {
      review: { label: "Ask", hint: "Uses fx's saved permission rules and asks before changes" },
      trusted: { label: "Auto review", hint: "fx checks actions automatically and asks when needed" },
      autonomous: { label: "Full access", hint: "Runs actions without asking, outside the sandbox" },
    }[mode];
  }
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
  if (agent === "fx") return mode !== "plan";
  if (agent === "antigravity") return mode === "plan" || mode === "autonomous";
  return !((agent === "opencode" || agent === "acp" || agent === "cursor") && (mode === "review" || mode === "trusted"));
}

export function executionModeUnavailable(agent: AgentKind | undefined, mode: ExecutionMode): string | null {
  if (executionModeAvailable(agent, mode)) return null;
  if (agent === "fx") return "fx does not expose a read-only Plan mode. Choose Ask, Auto review or Full access, or use another agent for Plan.";
  if (agent === "antigravity")
    return "Antigravity applies its saved permission rules and cannot guarantee approval before every command through this integration. Choose Plan or Autonomous, or use another agent.";
  if (agent === "cursor")
    return "Cursor applies its own saved permission rules and cannot guarantee approval before every command through this integration. Choose Plan or Autonomous, or use another provider.";
  return `OpenCode cannot currently guarantee approval before every command through this integration. Choose Claude for ${executionModeLabel[mode]}, or explicitly choose another mode.`;
}

/** What the mode does with this agent, or why the agent cannot run it. */
export function executionModeNote(agent: AgentKind | undefined, mode: ExecutionMode): string {
  return executionModeUnavailable(agent, mode) ?? executionModePresentation(agent, mode).hint;
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
