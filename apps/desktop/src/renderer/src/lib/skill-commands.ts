import { useClaudeAccountId } from "./claude-account";
import { WORKSPACE_ID, type AgentKind, type FileScope } from "@openorc/protocol";
import type { SkillCommands, SkillListOptions } from "@openorc/client";
import { client } from "./client";

/** A project's folder before its conversation exists. Only a Workspace conversation, an Orcling's own included, chooses its own. */
export function projectScope(projectId: string | null | undefined, folder?: string | null): FileScope | null {
  if (!projectId) return null;
  return projectId === WORKSPACE_ID && folder ? { kind: "project", id: projectId, workingDirectory: folder } : { kind: "project", id: projectId };
}

/** Where the person's own skills are read for a conversation that runs elsewhere: the Workspace, which holds no project's. */
export const OWN_SKILLS_SCOPE: FileScope = { kind: "project", id: WORKSPACE_ID };

/**
 * The selected agent's skills where a conversation works (`useSkillCommandsWith` in @openorc/client), with the Claude
 * account this window works with when the composer chose none.
 */
export function useSkillCommands(scope: FileScope | null, selectedAgent: AgentKind | null | undefined, selectedAccountId?: string, options?: SkillListOptions): SkillCommands {
  const scopedAccountId = useClaudeAccountId();
  return client.useSkillCommands(scope, selectedAgent, selectedAccountId ?? scopedAccountId, options);
}
