import os from "node:os";
import path from "node:path";

/** Where Claude Code keeps its settings, plans, and skills: `CLAUDE_CONFIG_DIR` or `~/.claude`. */
export function claudeConfigDir(home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  return env["CLAUDE_CONFIG_DIR"] || path.join(home, ".claude");
}

/**
 * Set on an added account's environment: the existing CLI login's config folder,
 * whose skills and plugins the account uses as well. Claude Code never reads it;
 * the launcher and the skill list do.
 */
export const SHARED_CLAUDE_CONFIG_DIR = "OPENORC_CLAUDE_SHARED_CONFIG_DIR";
