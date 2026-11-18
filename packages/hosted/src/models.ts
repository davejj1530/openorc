/**
 * The models OpenOrc Cloud runs for the person, as its machines' own agent CLIs list them: the person's, whichever space
 * asks, so the session's own asks. A server from before the catalog answers 404: that is remembered for the session,
 * and its absence answers null. A turn's end that keeps a new listing says so (`models`), and the windows read it again.
 */
import type { HostedDeps } from "./index.js";
import { Refused, type Session } from "./session.js";
import { SOCKET, wireTopics } from "./wire.js";
import { MODEL_ROUTES, type WireCloudModels } from "./wire-models.js";

export class CloudModels {
  /** The session generation whose server answered it keeps no catalog. */
  #missingIn: number | null = null;

  constructor(private readonly deps: { session: Session } & Pick<HostedDeps, "push">) {
    deps.session.onSocket(SOCKET.changed, (body) => {
      const topics = wireTopics.safeParse(body);
      if (topics.success && topics.data.topics.includes("models")) deps.push({ type: "invalidate", keys: ["cloud-models"] });
    });
  }

  async read(): Promise<WireCloudModels | null> {
    const generation = this.deps.session.generation;
    if (this.#missingIn === generation) return null;
    try {
      return await this.deps.session.request(MODEL_ROUTES.read());
    } catch (error) {
      if (!(error instanceof Refused) || error.status !== 404) throw error;
      this.#missingIn = generation;
      return null;
    }
  }
}
