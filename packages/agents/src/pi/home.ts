import os from "node:os";
import path from "node:path";

export function piAgentDir(home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  return env["PI_CODING_AGENT_DIR"] || path.join(home, ".pi", "agent");
}
