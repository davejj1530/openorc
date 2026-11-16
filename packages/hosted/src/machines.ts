/**
 * The person's machines awake now, as Settings > Cloud lists them, and the stop of one. A server from before machines
 * answers 404: that is remembered for the session, so the page asks it again only after a new sign-in or start.
 */
import type { CloudMachines as Machines } from "@openorc/protocol";
import { Refused, type Session } from "./session.js";
import { MACHINE_ROUTES, type WireMachines } from "./wire-machines.js";

const ready = ({ machines }: WireMachines): Machines => ({ state: "ready", machines: machines.map((one) => ({ ...one, since: Date.parse(one.since), changing: one.changing ?? false })) });

export class CloudMachines {
  /** The session generation whose server answered it has no machines. */
  #missingIn: number | null = null;

  constructor(private readonly deps: { session: Session }) {}

  async read(): Promise<Machines> {
    const generation = this.deps.session.generation;
    if (this.#missingIn === generation) return { state: "unavailable" };
    try {
      return ready(await this.deps.session.request(MACHINE_ROUTES.read));
    } catch (error) {
      if (!(error instanceof Refused) || error.status !== 404) throw error;
      this.#missingIn = generation;
      return { state: "unavailable" };
    }
  }

  /** Stops one; refused in words while it can't stop. One no longer running for them answers the list as it is now. */
  async stop(id: string): Promise<Machines> {
    try {
      return ready(await this.deps.session.request(MACHINE_ROUTES.stop(id)));
    } catch (error) {
      if (error instanceof Refused && error.status === 404) return this.read();
      throw error;
    }
  }
}
