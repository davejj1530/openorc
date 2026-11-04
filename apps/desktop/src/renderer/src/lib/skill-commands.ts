import { useClaudeAccountId } from "./claude-account";
import { useMemo } from "react";
import { WORKSPACE_ID, type AgentKind, type AgentSkill } from "@openorc/protocol";
import type { SlashCommand } from "../components/Composer";
import { useRpc } from "./client";

/** What this project brought comes first: a personal or plugin skill reaches every project, so it says less about this one. */
const SOURCE_ORDER: Record<AgentSkill["source"], number> = { project: 0, user: 1, plugin: 2, system: 3 };

/**
 * The selected harness's explicit skills, for every composer rather than one.
 *
 * Claude accepts `/name` and Codex accepts `$name` in prompt text. OpenCode
 * loads skills through its native tool, so it has no text insertion here.
 *
 * One hook rather than the same query written at each call site: the settings
 * list and all four composers then share a single cache entry, and cannot
 * drift apart on how long they hold it.
 *
 * A project's conversations share the project's skills. A Workspace
 * conversation, an Orcling's own included, works in its own folder, so
 * `folder` says which; elsewhere it is ignored. The list is read again every
 * minute, so a skill installed while a conversation is open shows up in it.
 */
export function useSkillCommands(projectId: string | null | undefined, selectedAgent: AgentKind | null | undefined, folder?: string | null, selectedAccountId?: string): SlashCommand[] {
  const scopedAccountId = useClaudeAccountId();
  const claudeAccountId = selectedAccountId ?? scopedAccountId;
  const agent = selectedAgent === "acp" ? "opencode" : selectedAgent;
  const workingDirectory = projectId === WORKSPACE_ID ? folder : null;
  const skills = useRpc(
    "skills.list",
    { ...(agent === "claude" && claudeAccountId ? { claudeAccountId } : {}), projectId: projectId ?? "", ...(workingDirectory ? { workingDirectory } : {}), agent: agent ?? "claude" },
    { enabled: Boolean(projectId && agent && agent !== "opencode"), staleTime: 60_000, refetchInterval: 60_000 },
  );
  const found = skills.data;
  return useMemo(
    () =>
      agent === "opencode"
        ? []
        : [...(found ?? [])]
            .sort((a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source])
            .map((skill) => ({ name: skill.name, hint: skill.description, insert: true as const, prefix: agent === "codex" ? ("$" as const) : ("/" as const) })),
    [agent, found],
  );
}
