/**
 * A cloud project's own environment variables, which every turn in its cloud threads runs with. The server keeps each
 * value sealed and never sends one back, so what is read is each variable's name and when it was set.
 *
 * A server that keeps no project environment, behind its switch or from before it, reads as unavailable, and the app
 * offers nothing to change. Any other failure is the caller's to show.
 */
import type { HostedEnvironment, HostedEnvironmentSave } from "@openorc/protocol";
import { Refused, type Session } from "./session.js";
import { PARITY_ROUTES } from "./wire-parity.js";
import { ENVIRONMENT_ROUTES, EnvironmentNameRefused, type WireEnvironment } from "./wire-environment.js";

const ready = (wire: WireEnvironment) => ({
  state: "ready" as const,
  variables: wire.variables.map((variable) => ({ name: variable.name, updatedAt: Date.parse(variable.updatedAt) })),
  canChange: wire.canChange,
});

const unavailable = (error: unknown) => error instanceof Refused && (error.status === 404 || (error.status === 409 && error.code === "feature_unavailable"));

/** How long "not available" stands before the server is asked again. */
const ASK_AGAIN_MS = 60_000;

export class ProjectEnvironment {
  #generation = -1;
  /** What each space's server said of the capability, and when, this session. */
  readonly #served = new Map<string, { available: boolean; at: number }>();

  constructor(private readonly deps: { session: Session; now(): number }) {}

  /** Whether `space`'s server keeps projects' environments. Asked once a session where it does, again after a minute where it does not. */
  async available(space: string): Promise<boolean> {
    if (this.#generation !== this.deps.session.generation) {
      this.#generation = this.deps.session.generation;
      this.#served.clear();
    }
    const served = this.#served.get(space);
    if (served && (served.available || this.deps.now() - served.at < ASK_AGAIN_MS)) return served.available;
    let available: boolean;
    try {
      available = (await this.deps.session.in(space).request(PARITY_ROUTES.capabilities)).features.projectEnvironment?.available === true;
    } catch (error) {
      // A server from before capabilities has no project environment either.
      if (!(error instanceof Refused) || error.status !== 404) throw error;
      available = false;
    }
    this.#served.set(space, { available, at: this.deps.now() });
    return available;
  }

  async read(space: string, projectId: string): Promise<HostedEnvironment> {
    try {
      return ready(await this.deps.session.in(space).request(ENVIRONMENT_ROUTES.read(projectId)));
    } catch (error) {
      if (unavailable(error)) return { state: "unavailable" };
      throw error;
    }
  }

  /** Sets every variable or none; a refused name answers with its sentence, which belongs under that variable. */
  async set(space: string, projectId: string, variables: readonly { name: string; value: string }[]): Promise<HostedEnvironmentSave> {
    try {
      const saved = ready(await this.deps.session.in(space).request(ENVIRONMENT_ROUTES.set(projectId), { variables }));
      return { ...saved, state: "saved" };
    } catch (error) {
      if (error instanceof EnvironmentNameRefused) return { state: "refused", name: error.variable, message: error.message };
      throw error;
    }
  }

  async remove(space: string, projectId: string, name: string): Promise<HostedEnvironment> {
    return ready(await this.deps.session.in(space).request(ENVIRONMENT_ROUTES.remove(projectId, name)));
  }
}
