import os from "node:os";
import path from "node:path";

/** Where Claude Code keeps its settings, plans, and skills: `CLAUDE_CONFIG_DIR` or `~/.claude`. */
export function claudeConfigDir(home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  return env["CLAUDE_CONFIG_DIR"] || path.join(home, ".claude");
}
