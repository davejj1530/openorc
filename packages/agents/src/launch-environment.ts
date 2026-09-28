import { harnessCatalog, type HarnessId } from "@openorc/protocol";

/**
 * The complete process environment admitted for one provider operation.
 * Callers capture it before awaiting so a later shell refresh cannot split a
 * binary from the PATH and credentials/configuration it was resolved under.
 */
export interface AgentLaunchEnvironment {
  readonly revision: number;
  readonly binary: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly processRegistry?: string;
}

export interface ResolvedHarnessEnvironment {
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
  return Object.freeze({ revision: snapshot.revision, binary, env: snapshot.env });
}

/** Complete immutable environment for a provider-independent probe. */
export function captureProcessEnvironment(snapshot: ResolvedHarnessEnvironment): Readonly<NodeJS.ProcessEnv> {
  return snapshot.env;
}
