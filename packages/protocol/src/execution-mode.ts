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
  plan: "Investigate and propose a plan. Project changes, external writes, browser input, and memory changes are blocked.",
  review: "Read and search freely. Every command, edit, external write, browser input, and memory change asks first.",
  trusted: "Allow workspace file edits and memory changes. Every command, external write, and browser input asks first.",
  autonomous: "Tool permissions run automatically. Questions and password fields still ask.",
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
      review: { label: "Review changes", hint: "Read-only sandbox. Reads and read-only commands run freely; changes and sandbox escalation ask you for approval." },
      trusted: { label: "Ask for approval", hint: "Workspace edits and sandboxed commands run freely. Network access and actions outside the sandbox ask you for approval." },
      autonomous: { label: "Full access", hint: "Codex runs without a sandbox or tool approval prompts. Questions that need your input still ask." },
    }[mode];
  }
  return { label: executionModeLabel[mode], hint: executionModeHint[mode] };
}

export function executionModeUnavailable(agent: AgentKind, mode: ExecutionMode): string | null {
  if ((agent === "opencode" || agent === "acp") && (mode === "review" || mode === "trusted"))
    return `OpenCode cannot currently guarantee approval before every command through this integration. Choose Claude for ${executionModeLabel[mode]}, or explicitly choose another mode.`;
  return null;
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
