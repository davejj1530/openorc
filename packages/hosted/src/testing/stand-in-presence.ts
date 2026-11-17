/**
 * The stand-in's ask before an alert, as the server makes it: `hosted:presence` with `{}`, to the person's own live
 * sockets alone, waiting a second at most. In use only on one exact `{ inUse: true }`; no answer, a late one or any
 * other shape reads as away, and nothing is kept between asks.
 */
import type { StandInPeer } from "./stand-in-peer.js";

const PRESENCE = "hosted:presence";
const WAIT_MS = 1_000;

const inUse = (answer: unknown): boolean => typeof answer === "object" && answer !== null && Object.keys(answer).length === 1 && (answer as { inUse?: unknown }).inUse === true;

export function presenceOf(peers: () => StandInPeer[]): (email: string, ms?: number) => Promise<boolean> {
  return async (email, ms = WAIT_MS) => {
    const who = email.toLowerCase();
    const asked = peers().filter((peer) => peer.who() === who && peer.ask);
    const late = () => new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms));
    const answers = await Promise.all(asked.map((peer) => Promise.race([peer.ask!(PRESENCE, {}).catch(() => undefined), late()])));
    return answers.some(inUse);
  };
}
