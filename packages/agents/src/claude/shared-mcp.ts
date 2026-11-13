import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Claude Code keeps its state beside the default config folder, and inside any other. */
export function claudeStateFile(configDir: string, home = os.homedir()): string {
  return configDir === path.join(home, ".claude") ? path.join(home, ".claude.json") : path.join(configDir, ".claude.json");
}

/**
 * The servers the CLI login configured for all its projects, as written there. An added account runs them too, so
 * switching accounts never changes an agent's tools; each account still signs in to a remote one for itself.
 */
export function sharedClaudeMcpServers(shared: string | undefined, home = os.homedir()): Record<string, unknown> {
  if (!shared) return {};
  try {
    const state: unknown = JSON.parse(readFileSync(claudeStateFile(shared, home), "utf8"));
    const servers = (state as { mcpServers?: unknown } | null)?.mcpServers;
    return servers && typeof servers === "object" && !Array.isArray(servers) ? (servers as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Settings for one run that keep the servers the user turned off from loading. */
export function connectorsOffSettings(off: readonly string[] | undefined): { deniedMcpServers?: { serverName: string }[] } {
  return off?.length ? { deniedMcpServers: off.map((serverName) => ({ serverName })) } : {};
}

/** The CLI login's servers for one run: only where the user's own servers load at all, and never onto another machine, which has its own configuration. */
export function sharedServersForRun(run: { restricted: boolean; strictMcp: boolean; untrusted: boolean; onAnotherMachine: boolean }, shared: string | undefined): Record<string, unknown> {
  return run.restricted || run.strictMcp || run.untrusted || run.onAnotherMachine ? {} : sharedClaudeMcpServers(shared);
}
