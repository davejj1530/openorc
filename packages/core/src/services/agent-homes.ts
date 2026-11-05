import os from "node:os";
import path from "node:path";
import { hostHome, type AgentHome } from "@openorc/agents";
import type { Sandbox } from "@openorc/cloud";
import type { HarnessId } from "@openorc/protocol";
import type { AgentHomes, HomeOwner } from "./agent-sessions.js";
import type { CloudAgents } from "./cloud-agents.js";
import { RelocationRefused } from "./relocation-package.js";
import type { EnvSnapshot } from "./shell-environment.js";

export interface AgentHomeDeps {
  environment(): EnvSnapshot;
  /** The account's Claude folder here; null when this host has no such account. */
  claudeFolder(accountId: string | null): string | null;
  /** Each agent's sign-in, which names its folders in a sandbox. */
  agents: CloudAgents;
}

/** Each agent's folders on this host and in its threads' sandboxes. */
export function agentHomes(deps: AgentHomeDeps): AgentHomes {
  return {
    here(thread) {
      const snapshot = deps.environment();
      return hostHome({
        agent: thread.agent,
        userHome: snapshot.env["HOME"] || os.homedir(),
        env: hostFolders(thread, snapshot.env, deps),
        binary: snapshot.binaries[thread.agent] ?? thread.agent,
        processEnv: snapshot.env,
      });
    },
    async sandbox(thread, location, provider) {
      const env = await deps.agents[thread.agent].signIn.homeEnv(location.install.state, provider, { claudeAccountId: thread.claudeAccountId ?? null, model: null });
      return env && sandboxHome(location.install.sandbox, thread.agent, env);
    },
  };
}

function hostFolders(thread: HomeOwner, env: NodeJS.ProcessEnv, deps: AgentHomeDeps): Record<string, string> {
  if (thread.agent === "claude") {
    const folder = deps.claudeFolder(thread.claudeAccountId ?? null);
    if (!folder) throw new RelocationRefused("Its Claude account is not here.");
    return { CLAUDE_CONFIG_DIR: folder };
  }
  if (thread.agent === "codex") return { CODEX_HOME: env["CODEX_HOME"] || path.join(env["HOME"] || os.homedir(), ".codex") };
  return env["XDG_DATA_HOME"] ? { XDG_DATA_HOME: env["XDG_DATA_HOME"] } : {};
}

/** An agent's folders in a sandbox, read and written through its commands. */
export async function sandboxHome(sandbox: Sandbox, agent: HarnessId, env: Record<string, string>): Promise<AgentHome> {
  const sh = (script: string, ...args: string[]) => sandbox.exec("sh", ["-c", script, "sh", ...args]);
  const userHome = (await sh('printf %s "$HOME"')).stdout.toString("utf8").trim();
  const lines = (out: Buffer) => out.toString("utf8").split("\n").filter(Boolean);
  return {
    agent,
    machine: "sandbox",
    userHome,
    env,
    binary: agent,
    read: (file) => sandbox.readFile(file),
    async write(file, bytes) {
      await sandbox.writeFile(file, bytes);
    },
    async remove(file) {
      await sh('rm -f -- "$1"', file);
    },
    async list(dir, options) {
      if (!options?.recursive) return lines((await sh('ls -1A -- "$1" 2>/dev/null', dir)).stdout);
      return lines((await sh('cd -- "$1" 2>/dev/null && find . -type f', dir)).stdout).map((file) => file.replace(/^\.\//, ""));
    },
    realpath: async (file) => (await sh('realpath -m -- "$1"', file)).stdout.toString("utf8").trim() || file,
    async run(args, options) {
      const result = await sandbox.exec(agent, [...args], { ...(options?.cwd ? { cwd: options.cwd } : {}), env });
      return { code: result.code ?? -1, stdout: result.stdout, stderr: result.stderr };
    },
  };
}
