import type { WireMachines } from "../wire-machines.js";

/**
 * A person's awake machines, as a server with machines lists them, and their stop. A server from before machines has no
 * such route: `present` false, every request falls through to the 404 an unknown route gets. A stop of a machine that
 * can't stop answers 409 with its reason, of one not listed 404, and otherwise takes it off the person's list.
 */
type Reply = { status: number; body: unknown };
type Machine = WireMachines["machines"][number];

const refused = (status: number, message: string): Reply => ({ status, body: { statusCode: status, message } });

export class StandInMachines {
  present = false;
  /** Each person's machines, by the email they signed in with. */
  readonly awake = new Map<string, Machine[]>();

  route(request: { method: string; path: string }, who: string): Reply | null {
    if (!this.present || !request.path.startsWith("/hosted/machines")) return null;
    const mine = this.awake.get(who) ?? [];
    if (request.method === "GET" && request.path === "/hosted/machines") return { status: 200, body: { machines: mine } };
    const [, id] = /^\/hosted\/machines\/([^/]+)\/stop$/.exec(request.path) ?? [];
    if (request.method !== "POST" || !id) return null;
    const machine = mine.find((one) => one.id === decodeURIComponent(id));
    if (!machine) return refused(404, "That machine isn't running for you.");
    if (!machine.stop.can) return refused(409, machine.stop.reason);
    this.awake.set(
      who,
      mine.filter((one) => one !== machine),
    );
    return { status: 200, body: { machines: this.awake.get(who) } };
  }
}
