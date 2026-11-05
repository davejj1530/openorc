import { DOOR_PATH, doorTicket, knockBody, readDoorLine, readDoorRefusal, type DoorOutcome, type DoorRefusalReason, type DoorTicket, type LinkCrypto } from "@openorc/link";
import type { DoorKey, Route } from "@openorc/protocol";
import type { Clock } from "./route-race";

/** What a knock on a host's door came to, in the phone's terms. */
export type WakeOutcome =
  /** The host answers on this route now. */
  | { kind: "ready"; route: Route }
  /** The door does not take this phone's knock, even on its clock: unpaired, or the host was set up again. */
  | { kind: "refused" }
  /** Only OpenOrc on the Mac can help: a ticket too old, a door too old, or a host that needs setting up again. */
  | { kind: "needs-mac" }
  /** It did not start; a later knock may. */
  | { kind: "failed" }
  /** No door answered: none saved, none deployed, or no way to it. The host reads as it does without one. */
  | { kind: "unanswered" };

/** A door's answer as the phone reads it: its status, then its body whole or line by line as it comes. */
export interface DoorResponse {
  status: number;
  text(): Promise<string>;
  lines(): AsyncIterable<string>;
}

export type DoorPost = (url: string, init: { body: string; signal: AbortSignal }) => Promise<DoorResponse>;

/** Each host's door key, as text: a secret, so in the Keychain beside the device key, never in MMKV. */
export interface DoorKeyStore {
  read(macId: string): Promise<string | null>;
  write(macId: string, value: string): Promise<void>;
  remove(macId: string): Promise<void>;
}

export interface PhoneDoors {
  /** What a session's host gave: its key, or null for none, which forgets any saved. */
  learn(macId: string, key: DoorKey | null): Promise<void>;
  has(macId: string): Promise<boolean>;
  /** Knocks on the saved door and waits for its answer, at most KNOCK_WITHIN_MS or until `signal` aborts. */
  knock(macId: string, signal: AbortSignal): Promise<WakeOutcome>;
  forget(macId: string): Promise<void>;
}

/** A wake takes about 10 s, 40 s against a sleep under way, and a door gives up at 300 s. */
const KNOCK_WITHIN_MS = 180_000;
/** A refusal whose clock sits this far from the phone's is signed again once, on the door's clock. */
const SKEW_RETRY_MS = 30_000;

/** An unknown state reads as failed: it woke nothing the phone can reach. */
const OUTCOMES: { [K in DoorOutcome["state"]]: (outcome: Extract<DoorOutcome, { state: K }>) => WakeOutcome } = {
  ready: (outcome) => ({ kind: "ready", route: outcome.route }),
  "needs-mac": () => ({ kind: "needs-mac" }),
  failed: () => ({ kind: "failed" }),
};
const outcomeOf = (outcome: DoorOutcome): WakeOutcome => (OUTCOMES[outcome.state] as (outcome: DoorOutcome) => WakeOutcome)(outcome);
const REFUSALS: Record<DoorRefusalReason | "unknown", WakeOutcome> = {
  denied: { kind: "refused" },
  expired: { kind: "needs-mac" },
  "door-outdated": { kind: "needs-mac" },
  "needs-mac": { kind: "needs-mac" },
  unknown: { kind: "failed" },
};

/** The lines of a streamed body, as they arrive. */
export async function* streamLines(body: ReadableStream<Uint8Array> | null): AsyncIterable<string> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      yield* parts;
    }
    if (pending) yield pending;
  } finally {
    reader.releaseLock();
  }
}

export function phoneDoors(deps: { crypto: Pick<LinkCrypto, "hmacSha256" | "randomBytes">; clock: Clock; post: DoorPost; keys: DoorKeyStore }): PhoneDoors {
  const known = new Map<string, DoorTicket | null>();

  const read = async (macId: string): Promise<DoorTicket | null> => {
    if (known.has(macId)) return known.get(macId)!;
    const text = await deps.keys.read(macId).catch(() => null);
    let ticket: DoorTicket | null = null;
    try {
      ticket = text ? doorTicket(JSON.parse(text) as DoorKey) : null;
    } catch {
      ticket = null;
    }
    known.set(macId, ticket);
    return ticket;
  };

  /** The door's 200 answer: accepted, then done. One that ends or is cut without done woke nothing the phone saw. */
  const follow = async (response: DoorResponse): Promise<WakeOutcome> => {
    let accepted = false;
    try {
      for await (const text of response.lines()) {
        const line = readDoorLine(text);
        if (line?.t === "accepted") accepted = true;
        else if (line?.t === "done") return outcomeOf(line.outcome);
      }
    } catch {
      // Cut: the network dropped, or the phone stopped waiting.
    }
    return accepted ? { kind: "failed" } : { kind: "unanswered" };
  };

  const knock = async (key: DoorTicket, signal: AbortSignal): Promise<WakeOutcome> => {
    const send = (at: number) => deps.post(`https://${key.host}${DOOR_PATH}`, { body: knockBody(deps.crypto, key, at), signal });
    const sentAt = deps.clock.now();
    let response = await send(sentAt);
    if (response.status === 403) {
      let refusal = readDoorRefusal(await response.text());
      const heardAt = deps.clock.now();
      if (refusal?.why === "denied" && Math.abs(refusal.now - sentAt) > SKEW_RETRY_MS) {
        response = await send(refusal.now + deps.clock.now() - heardAt);
        refusal = response.status === 403 ? readDoorRefusal(await response.text()) : null;
      }
      if (refusal) return REFUSALS[refusal.why];
    }
    if (response.status === 200) return follow(response);
    // A 403 that is no door's refusal is a page in the way, such as Vercel's login: no door answered.
    return response.status >= 500 ? { kind: "failed" } : { kind: "unanswered" };
  };

  return {
    async learn(macId, key) {
      const ticket = key && doorTicket(key);
      known.set(macId, ticket);
      if (ticket) await deps.keys.write(macId, JSON.stringify({ host: key.host, device: key.device, epoch: key.epoch, ticket: key.ticket }));
      else await deps.keys.remove(macId);
    },
    has: async (macId) => (await read(macId)) !== null,
    async knock(macId, signal) {
      const key = await read(macId);
      if (!key || signal.aborted) return { kind: "unanswered" };
      const abort = new AbortController();
      const stop = () => abort.abort();
      signal.addEventListener("abort", stop);
      const timer = deps.clock.setTimeout(stop, KNOCK_WITHIN_MS);
      try {
        return await knock(key, abort.signal);
      } catch {
        return { kind: "unanswered" };
      } finally {
        deps.clock.clearTimeout(timer);
        signal.removeEventListener("abort", stop);
      }
    },
    async forget(macId) {
      known.delete(macId);
      await deps.keys.remove(macId);
    },
  };
}
