import os from "node:os";
import path from "node:path";
import type { AgentKind, InstructionFile } from "@openorc/protocol";
import { claudeConfigDir } from "./claude/config-dir.js";

/**
 * The instruction files an agent reads for a folder, AGENTS.md first. Claude also reads the folder's CLAUDE.md,
 * and each agent keeps one personal file that every project shares.
 */
export function instructionFiles({
  agent,
  folder,
  home = os.homedir(),
  env = process.env,
}: {
  agent: AgentKind;
  folder: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}): Pick<InstructionFile, "scope" | "path">[] {
  const names = agent === "claude" ? ["AGENTS.md", "CLAUDE.md"] : ["AGENTS.md"];
  const personal = personalInstructionFile(agent, home, env);
  return [...names.map((name) => ({ scope: "project" as const, path: path.join(folder, name) })), ...(personal ? [{ scope: "personal" as const, path: personal }] : [])];
}

/** Other agents that speak ACP keep their personal instructions in places of their own, so none is assumed. */
function personalInstructionFile(agent: AgentKind, home: string, env: NodeJS.ProcessEnv): string | null {
  if (agent === "claude") return path.join(claudeConfigDir(home, env), "CLAUDE.md");
  if (agent === "codex") return path.join(env["CODEX_HOME"] || path.join(home, ".codex"), "AGENTS.md");
  if (agent === "opencode") return path.join(env["XDG_CONFIG_HOME"] || path.join(home, ".config"), "opencode", "AGENTS.md");
  return null;
}
