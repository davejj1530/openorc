/**
 * A person's own connectors in their cloud turns: one HTTPS server for each agent that should have it, with the
 * headers it is asked with. The server keeps each value sealed and never sends one back. A connector is saved for
 * several agents at once, one request each, and checked once after a save; the check's answer is kept for the
 * session, as the server keeps none.
 *
 * A server that keeps no connectors, behind its switch or from before it, reads as unavailable. Any other failure is
 * the caller's to show.
 */
import type { HostedConnectorAgent, HostedConnectorCheck, HostedConnectors } from "@openorc/protocol";
import { Refused, type Session } from "./session.js";
import { CONNECTOR_ROUTES, type WireConnector } from "./wire-connectors.js";

const unavailable = (error: unknown) => error instanceof Refused && (error.status === 404 || (error.status === 409 && error.code === "feature_unavailable"));

type Header = { name: string; value: string } | { name: string; keep: true };

export class CloudConnectors {
  #generation = -1;
  /** Each connector's last check this session, by agent and name. */
  readonly #checks = new Map<string, HostedConnectorCheck>();

  constructor(private readonly deps: { session: Session }) {}

  #checked(): Map<string, HostedConnectorCheck> {
    if (this.#generation !== this.deps.session.generation) {
      this.#generation = this.deps.session.generation;
      this.#checks.clear();
    }
    return this.#checks;
  }

  #ready(wire: readonly WireConnector[]): HostedConnectors {
    const checks = this.#checked();
    return {
      state: "ready",
      connectors: wire.map((one) => ({
        ...one,
        headers: one.headers.map((header) => ({ name: header.name, updatedAt: Date.parse(header.updatedAt) })),
        updatedAt: Date.parse(one.updatedAt),
        check: checks.get(`${one.agent}/${one.name}`) ?? null,
      })),
    };
  }

  async read(): Promise<HostedConnectors> {
    try {
      return this.#ready((await this.deps.session.request(CONNECTOR_ROUTES.read)).connectors);
    } catch (error) {
      if (unavailable(error)) return { state: "unavailable" };
      throw error;
    }
  }

  /**
   * Saves one connector for `agents`, each with the same address and headers, and removes it from the agents it had
   * and is not given now. Then checks it for the first agent, and answers what the person has.
   */
  async save(input: { name: string; url: string; headers: readonly Header[]; agents: readonly HostedConnectorAgent[] }): Promise<HostedConnectors> {
    const had = (await this.deps.session.request(CONNECTOR_ROUTES.read)).connectors.filter((one) => one.name === input.name);
    for (const agent of input.agents) await this.deps.session.request(CONNECTOR_ROUTES.save(agent, input.name), { url: input.url, headers: input.headers });
    for (const one of had) if (!input.agents.includes(one.agent)) await this.deps.session.request(CONNECTOR_ROUTES.remove(one.agent, input.name));
    const [first] = input.agents;
    if (first) {
      const checks = this.#checked();
      for (const agent of input.agents) checks.delete(`${agent}/${input.name}`);
      // The save stands whatever the check says; a check the server refuses, such as one too many a minute, says why.
      const check = await this.deps.session.request(CONNECTOR_ROUTES.check(first, input.name)).catch((error: unknown) => {
        if (error instanceof Refused) return { status: "failed" as const, message: error.message };
        throw error;
      });
      checks.set(`${first}/${input.name}`, check);
    }
    return this.read();
  }

  /** Removes one connector from every agent's cloud connections. */
  async remove(name: string): Promise<HostedConnectors> {
    const had = (await this.deps.session.request(CONNECTOR_ROUTES.read)).connectors.filter((one) => one.name === name);
    for (const one of had) {
      await this.deps.session.request(CONNECTOR_ROUTES.remove(one.agent, name));
      this.#checked().delete(`${one.agent}/${name}`);
    }
    return this.read();
  }
}
