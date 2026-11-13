import os from "node:os";
import path from "node:path";
import type { AgentKind, InstructionFile } from "@openorc/protocol";
import { claudeConfigDir } from "./claude/config-dir.js";
import { ompAgentDir } from "./omp/home.js";
import { piAgentDir } from "./pi/home.js";
import { fxHome } from "./fx/home.js";

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
  const names = ["AGENTS.md"];
  if (agent === "antigravity") names.push("GEMINI.md");
  if (agent === "claude" || agent === "cursor") names.push("CLAUDE.md");
  const personal = personalInstructionFile(agent, home, env);
  return [...names.map((name) => ({ scope: "project" as const, path: path.join(folder, name) })), ...(personal ? [{ scope: "personal" as const, path: personal }] : [])];
}

/** Other agents that speak ACP keep their personal instructions in places of their own, so none is assumed. */
function personalInstructionFile(agent: AgentKind, home: string, env: NodeJS.ProcessEnv): string | null {
  if (agent === "claude") return path.join(claudeConfigDir(home, env), "CLAUDE.md");
  if (agent === "codex") return path.join(env["CODEX_HOME"] || path.join(home, ".codex"), "AGENTS.md");
  if (agent === "opencode") return path.join(env["XDG_CONFIG_HOME"] || path.join(home, ".config"), "opencode", "AGENTS.md");
  if (agent === "omp") return path.join(ompAgentDir(home, env), "AGENTS.md");
  if (agent === "pi") return path.join(piAgentDir(home, env), "AGENTS.md");
  if (agent === "antigravity") return path.join(home, ".gemini", "GEMINI.md");
  if (agent === "fx") return path.join(fxHome(env, home), "AGENTS.md");
  return null;
}
