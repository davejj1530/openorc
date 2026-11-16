/**
 * The person's machines awake now, as Settings > Cloud lists them, and the stop of one. A server from before machines
 * answers 404: that is remembered for the session, so the page asks it again only after a new sign-in or start.
 */
import type { CloudMachines as Machines } from "@openorc/protocol";
import { Refused, type Session } from "./session.js";
import { MACHINE_ROUTES, type WireMachines } from "./wire-machines.js";

const ready = ({ machines }: WireMachines): Machines => ({ state: "ready", machines: machines.map((one) => ({ ...one, since: Date.parse(one.since) })) });

export class CloudMachines {
  /** The session generation whose server answered it has no machines. */
  #missingIn: number | null = null;

  constructor(private readonly deps: { session: Session }) {}

  async read(): Promise<Machines> {
    if (this.#missingIn === this.deps.session.generation) return { state: "unavailable" };
    return this.#asked(() => this.deps.session.request(MACHINE_ROUTES.read));
  }

  /** Stops one; refused in words while it can't stop, as the server says. */
  stop(id: string): Promise<Machines> {
    return this.#asked(() => this.deps.session.request(MACHINE_ROUTES.stop(id)));
  }

  async #asked(ask: () => Promise<WireMachines>): Promise<Machines> {
    const generation = this.deps.session.generation;
    try {
      return ready(await ask());
    } catch (error) {
      if (!(error instanceof Refused) || error.status !== 404 || error.message.startsWith("That machine")) throw error;
      this.#missingIn = generation;
      return { state: "unavailable" };
    }
  }
}
