/**
 * The person's cloud check, as Settings > Cloud runs it: the last one read as it goes, and a new one started in the
 * space whose GitHub it tries. A server from before the check answers 404: that is remembered for the session, so it
 * is asked again only after a new sign-in or start.
 */
import type { CloudCheckState } from "@openorc/protocol";
import { Refused, type Session } from "./session.js";
import { CHECK_ROUTES, type WireCheckReply } from "./wire-check.js";

const ready = ({ check }: WireCheckReply): CloudCheckState => ({ state: "ready", check: check && { ...check, startedAt: Date.parse(check.startedAt) } });

export class CloudCheckRuns {
  /** The session generation whose server answered it has no check. */
  #missingIn: number | null = null;

  constructor(private readonly deps: { session: Session }) {}

  async read(): Promise<CloudCheckState> {
    const generation = this.deps.session.generation;
    if (this.#missingIn === generation) return { state: "unavailable" };
    try {
      return ready(await this.deps.session.request(CHECK_ROUTES.read));
    } catch (error) {
      if (!(error instanceof Refused) || error.status !== 404) throw error;
      this.#missingIn = generation;
      return { state: "unavailable" };
    }
  }

  /** Starts one; refused in words past six a minute. */
  async start(spaceId: string): Promise<CloudCheckState> {
    return ready(await this.deps.session.in(spaceId).request(CHECK_ROUTES.start));
  }
}
