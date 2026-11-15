import os from "node:os";
import path from "node:path";
import { hostHome, SessionRefused, sessionSlots } from "@openorc/agents";
import { harnessCatalog, type HarnessId } from "@openorc/protocol";
import type { AgentHomes, HomeOwner } from "./agent-sessions.js";
import type { EnvSnapshot } from "./shell-environment.js";

/* Kept with agent-sessions.ts from the person's own cloud; see the note at the top of that file. */

export interface AgentHomeDeps {
  environment(): EnvSnapshot;
  /** The account's Claude folder here; null when this host has no such account. */
  claudeFolder(accountId: string | null): string | null;
}

/** Each agent's folders on this host. */
export function agentHomes(deps: AgentHomeDeps): AgentHomes {
  return {
    here(thread) {
      const snapshot = deps.environment();
      return hostHome({
        agent: thread.agent,
        userHome: snapshot.env["HOME"] || os.homedir(),
        env: hostFolders(thread, snapshot.env, deps),
        binary: snapshot.binaries[thread.agent] ?? harnessCatalog[thread.agent].cli.bin,
        processEnv: snapshot.env,
      });
    },
  };
}

/** Each agent CLI's version on this host, read at most once a minute. */
export function hostVersions(homes: AgentHomes, everyMs = 60_000): (agent: HarnessId) => Promise<string | null> {
  const known = new Map<HarnessId, { at: number; version: Promise<string | null> }>();
  return (agent) => {
    const kept = known.get(agent);
    if (kept && Date.now() - kept.at < everyMs) return kept.version;
    const version = Promise.resolve()
      .then(() => sessionSlots[agent].version(homes.here({ agent, claudeAccountId: null })))
      .catch(() => null);
    known.set(agent, { at: Date.now(), version });
    return version;
  };
}

function hostFolders(thread: HomeOwner, env: NodeJS.ProcessEnv, deps: AgentHomeDeps): Record<string, string> {
  if (thread.agent === "claude") {
    const folder = deps.claudeFolder(thread.claudeAccountId ?? null);
    if (!folder) throw new SessionRefused("Its Claude account is not here.");
    return { CLAUDE_CONFIG_DIR: folder };
  }
  if (thread.agent === "codex") return { CODEX_HOME: env["CODEX_HOME"] || path.join(env["HOME"] || os.homedir(), ".codex") };
  if (thread.agent === "pi") return env["PI_CODING_AGENT_DIR"] ? { PI_CODING_AGENT_DIR: env["PI_CODING_AGENT_DIR"] } : {};
  return env["XDG_DATA_HOME"] ? { XDG_DATA_HOME: env["XDG_DATA_HOME"] } : {};
}
