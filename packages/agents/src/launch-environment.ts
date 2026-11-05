import { harnessCatalog, type HarnessId } from "@openorc/protocol";
import type { AgentHost } from "./agent-host.js";

/**
 * The complete process environment admitted for one provider operation.
 * Callers capture it before awaiting so a later shell refresh cannot split a
 * binary from the PATH and credentials/configuration it was resolved under.
 */
/**
 * The environment for a process started in `cwd`. Some CLIs (OpenCode) take their folder from PWD rather than the
 * process's own working directory, so an inherited PWD would put their sessions and instructions in the wrong folder.
 */
export function inFolder<E extends NodeJS.ProcessEnv | Record<string, string>>(env: E, cwd: string): E {
  return { ...env, PWD: cwd };
}

export interface AgentLaunchEnvironment {
  readonly scope?: string;
  readonly revision: number;
  readonly binary: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly processRegistry?: string;
  /** Where the CLI runs when not on this Mac. `binary`, `env` and the run's paths are then the host's. */
  readonly host?: AgentHost;
}

export interface ResolvedHarnessEnvironment {
  readonly scope?: string;
  readonly revision: number;
  readonly path: string;
  readonly binaries: Readonly<Record<HarnessId, string | null>>;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Pairs a resolved shell snapshot with every other launch variable at one
 * synchronous capture point. The frozen result is safe to carry across any
 * number of awaits without consulting mutable process state again.
 */
export function captureLaunchEnvironment(agent: HarnessId, snapshot: ResolvedHarnessEnvironment): AgentLaunchEnvironment {
  const binary = snapshot.binaries[agent];
  if (!binary) throw new Error(`${harnessCatalog[agent].name} was not found. Rescan after installing it.`);
  return Object.freeze({ revision: snapshot.revision, binary, env: snapshot.env, ...(snapshot.scope ? { scope: snapshot.scope } : {}) });
}

/** Complete immutable environment for a provider-independent probe. */
export function captureProcessEnvironment(snapshot: ResolvedHarnessEnvironment): Readonly<NodeJS.ProcessEnv> {
  return snapshot.env;
}
