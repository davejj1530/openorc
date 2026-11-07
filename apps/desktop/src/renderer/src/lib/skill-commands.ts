import { useClaudeAccountId } from "./claude-account";
import { useCallback, useMemo } from "react";
import { WORKSPACE_ID, type AgentKind, type AgentSkill, type FileScope } from "@openorc/protocol";
import type { CommandsNotice, SlashCommand } from "../components/Composer";
import { useRpc } from "./client";

/** A list this recent is used as it is when the picker opens. */
const FRESH_MS = 10_000;

/** Stands in while there is no scope; the read is disabled then, so it is never sent. */
const NO_SCOPE: FileScope = { kind: "project", id: "" };

/** A project's folder before its conversation exists. Only a Workspace conversation, an Orcling's own included, chooses its own. */
export function projectScope(projectId: string | null | undefined, folder?: string | null): FileScope | null {
  if (!projectId) return null;
  return projectId === WORKSPACE_ID && folder ? { kind: "project", id: projectId, workingDirectory: folder } : { kind: "project", id: projectId };
}

/** Reading a list with nothing yet clears its last error, so a read under way says so rather than nothing. */
function listNotice(prefix: "/" | "$", reading: boolean, error: Error | null): CommandsNotice | null {
  if (reading) return { prefix, text: "Loading skills…" };
  return error ? { prefix, text: "Couldn’t load skills", reason: error.message } : null;
}

/** What this project brought comes first: a personal or plugin skill reaches every project, so it says less about this one. */
const SOURCE_ORDER: Record<AgentSkill["source"], number> = { project: 0, user: 1, plugin: 2, system: 3 };

/**
 * The selected harness's explicit skills, for every composer rather than one.
 *
 * Claude accepts `/name` and Codex accepts `$name` in prompt text. OpenCode
 * loads skills through its native tool, so it has no text insertion here.
 *
 * One hook rather than the same query written at each call site: the composers
 * of one folder share a single cache entry, and cannot drift apart on how long
 * they hold it.
 *
 * The skills are those of the folder a conversation works in, a worktree's
 * own branch included; before it exists, the project's (`projectScope`).
 * Reading the list starts the agent's CLI, so it is read when a composer opens
 * and again when the composer asks, as a `/` or `$` word starts: a skill
 * installed while a conversation is open shows up the next time the picker
 * opens, not on a timer.
 */
export function useSkillCommands(
  scope: FileScope | null,
  selectedAgent: AgentKind | null | undefined,
  selectedAccountId?: string,
): { commands: SlashCommand[]; onCommandsWanted: () => void; commandsNotice: CommandsNotice | null } {
  const scopedAccountId = useClaudeAccountId();
  const claudeAccountId = selectedAccountId ?? scopedAccountId;
  const agent = selectedAgent === "acp" ? "opencode" : selectedAgent;
  const enabled = Boolean(scope && agent && agent !== "opencode");
  const skills = useRpc("skills.list", { ...(agent === "claude" && claudeAccountId ? { claudeAccountId } : {}), scope: scope ?? NO_SCOPE, agent: agent ?? "claude" }, { enabled, staleTime: FRESH_MS });
  const found = skills.data;
  const { dataUpdatedAt, isFetching, refetch } = skills;
  const prefix: "/" | "$" = agent === "codex" ? "$" : "/";
  // By the clock, not `isStale`: a list going stale renders nothing, so the flag can still say fresh.
  const onCommandsWanted = useCallback(() => {
    if (enabled && !isFetching && Date.now() - dataUpdatedAt > FRESH_MS) void refetch();
  }, [enabled, isFetching, dataUpdatedAt, refetch]);
  const commands = useMemo(
    () =>
      agent === "opencode"
        ? []
        : [...(found ?? [])]
            .sort((a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source])
            .map((skill) => ({
              name: skill.name,
              hint: skill.description,
              insert: true as const,
              prefix,
              ...(skill.aliases?.length ? { aliases: skill.aliases } : {}),
            })),
    [agent, found, prefix],
  );
  // A list read before keeps being offered while it is read again, and when that fails.
  const commandsNotice = enabled && !found ? listNotice(prefix, skills.isFetching, skills.error) : null;
  return { commands, onCommandsWanted, commandsNotice };
}
