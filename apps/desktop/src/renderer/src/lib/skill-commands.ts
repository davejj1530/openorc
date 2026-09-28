import { useMemo } from "react";
import type { AgentKind } from "@openorc/protocol";
import type { SlashCommand } from "../components/Composer";
import { useRpc } from "./query";

/**
 * The selected harness's explicit skills, for every composer rather than one.
 *
 * Claude accepts `/name` and Codex accepts `$name` in prompt text. OpenCode
 * loads skills through its native tool, so it has no text insertion here.
 *
 * One hook rather than the same query written at each call site: the settings
 * list and all four composers then share a single cache entry, and cannot
 * drift apart on how long they hold it.
 */
export function useSkillCommands(projectId: string | null | undefined, selectedAgent: AgentKind | null | undefined): SlashCommand[] {
  const agent = selectedAgent === "acp" ? "opencode" : selectedAgent;
  const skills = useRpc("skills.list", { projectId: projectId ?? "", agent: agent ?? "claude" }, { enabled: Boolean(projectId && agent && agent !== "opencode"), staleTime: 60_000 });
  const found = skills.data;
  return useMemo(
    () =>
      agent === "opencode" ? [] : (found ?? []).map((skill) => ({ name: skill.name, hint: skill.description, insert: true as const, prefix: agent === "codex" ? ("$" as const) : ("/" as const) })),
    [agent, found],
  );
}
