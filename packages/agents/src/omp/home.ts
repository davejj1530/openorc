import os from "node:os";
import path from "node:path";

/** Oh My Pi's own folder: its sessions, settings, skills and logins. PI_CODING_AGENT_DIR moves it, as `--profile` does. */
export function ompAgentDir(home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  return env["PI_CODING_AGENT_DIR"] || path.join(home, ".omp", "agent");
}
