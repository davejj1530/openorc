import type { DoorKey, Route } from "@openorc/protocol";
import { equalBytes, fromBase64Url, toBase64Url, utf8 } from "./bytes.js";
import { isRecord, oneOf, shape, type Check } from "./checks.js";
import type { LinkCrypto } from "./crypto.js";
import { readRoutes } from "./routes.js";

/**
 * A knock on a host's door, the small function that wakes a host asleep behind its proxy, and the door's answer. The
 * door holds the host's key, so it derives a phone's ticket from the device id the knock names and keeps no list of
 * phones. Each knock proves, under that ticket, the door's host, the device, the time and a fresh nonce.
 */

/** Where a door answers on its host: GET with its mark, POST to a knock. */
export const DOOR_PATH = "/api/door";
/** The knock this build signs. A door that reads only older ones refuses it as door-outdated. */
export const KNOCK_VERSION = 1;
/** How far a knock's time may sit from the door's clock. */
export const KNOCK_WINDOW_MS = 90_000;
const KNOCK_LABEL = "openorc-door knock/1";
const NONCE_BYTES = 16;
const PROOF_BYTES = 32;
const DEVICE = /^[A-Za-z0-9_-]{1,100}$/;

/** A phone's key to a door, with the ticket as bytes. */
export interface DoorTicket {
  host: string;
  device: string;
  epoch: number;
  ticket: Uint8Array;
}

export interface Knock {
  device: string;
  /** The epoch the ticket was issued for. */
  epoch: number;
  /** The phone's clock when it signed, in ms since the epoch. */
  at: number;
  nonce: Uint8Array;
  proof: Uint8Array;
}

function signed(host: string, knock: Omit<Knock, "proof">): Uint8Array {
  return utf8([KNOCK_LABEL, host, knock.device, knock.epoch, knock.at, toBase64Url(knock.nonce)].join("\n"));
}

/** The ticket out of the key the host gave; null when the key is not one this build can knock with. */
export function doorTicket(key: DoorKey): DoorTicket | null {
  if (!DEVICE.test(key.device) || !Number.isSafeInteger(key.epoch) || key.epoch < 0 || !/^[a-z0-9.-]{1,253}$/.test(key.host)) return null;
  try {
    const ticket = fromBase64Url(key.ticket);
    return ticket.length === PROOF_BYTES ? { host: key.host, device: key.device, epoch: key.epoch, ticket } : null;
  } catch {
    return null;
  }
}

/** A knock's JSON body, signed with the phone's clock at `at`. Good at this door only, and only near that time. */
export function knockBody(crypto: Pick<LinkCrypto, "hmacSha256" | "randomBytes">, key: DoorTicket, at: number): string {
  const knock = { device: key.device, epoch: key.epoch, at, nonce: crypto.randomBytes(NONCE_BYTES) };
  const proof = crypto.hmacSha256(key.ticket, signed(key.host, knock));
  return JSON.stringify({ v: KNOCK_VERSION, device: knock.device, epoch: knock.epoch, at, nonce: toBase64Url(knock.nonce), proof: toBase64Url(proof) });
}

const whole: Check = (value) => Number.isSafeInteger(value) && (value as number) >= 0;
const encoded =
  (bytes: number): Check =>
  (value) => {
    if (typeof value !== "string") return false;
    try {
      return fromBase64Url(value).length === bytes;
    } catch {
      return false;
    }
  };
const KNOCK = shape({
  v: (value) => value === KNOCK_VERSION,
  device: (value) => typeof value === "string" && DEVICE.test(value),
  epoch: whole,
  at: whole,
  nonce: encoded(NONCE_BYTES),
  proof: encoded(PROOF_BYTES),
});

/** What a door makes of a body: a knock, one from a newer phone than this door knows, or nothing it can read. */
export type ReadKnock = { kind: "knock"; knock: Knock } | { kind: "newer" } | { kind: "unreadable" };

export function readKnock(body: unknown): ReadKnock {
  if (isRecord(body) && typeof body["v"] === "number" && body["v"] > KNOCK_VERSION) return { kind: "newer" };
  if (!KNOCK(body)) return { kind: "unreadable" };
  const fields = body as { device: string; epoch: number; at: number; nonce: string; proof: string };
  return { kind: "knock", knock: { device: fields.device, epoch: fields.epoch, at: fields.at, nonce: fromBase64Url(fields.nonce), proof: fromBase64Url(fields.proof) } };
}

export const knockInWindow = (knock: Pick<Knock, "at">, now: number): boolean => Math.abs(now - knock.at) <= KNOCK_WINDOW_MS;

/** Whether the knock was signed at this door's host with this ticket. Constant time in the proof. */
export function knockProves(crypto: Pick<LinkCrypto, "hmacSha256">, knock: Knock, door: { host: string; ticket: Uint8Array }): boolean {
  return equalBytes(knock.proof, crypto.hmacSha256(door.ticket, signed(door.host, knock)));
}

/** What a door says once a wake it took is over. */
export type DoorOutcome =
  /** The host answers on this route now. */
  | { state: "ready"; route: Route }
  /** Only the host's Mac can help: the host needs setting up again, the door holds another key, or Vercel refused the door. */
  | { state: "needs-mac"; why: "setup" | "key" | "vercel" }
  | { state: "failed" };

/** One line of a door's 200 answer: accepted at once, blank lines while the host wakes, then done. */
export type DoorLine = { t: "accepted" } | { t: "done"; outcome: DoorOutcome };

/**
 * Why a door woke nothing. `denied` covers an unknown, revoked or tampered knock and a clock outside the window alike;
 * `expired` comes only from a knock whose proof holds under a ticket too old; `needs-mac` from a door without its config.
 */
export type DoorRefusalReason = "denied" | "expired" | "door-outdated" | "needs-mac";
export interface DoorRefusal {
  t: "refused";
  why: DoorRefusalReason;
  /** The door's clock, so a phone whose clock is off can sign again on it. */
  now: number;
}

export const doorLine = (line: DoorLine | DoorRefusal): string => `${JSON.stringify(line)}\n`;

const NEEDS_MAC = shape({ state: oneOf("needs-mac"), why: oneOf("setup", "key", "vercel") });

/** A phone built before a state reads it as failed: it woke nothing it can reach. */
function readOutcome(value: unknown): DoorOutcome {
  if (!isRecord(value)) return { state: "failed" };
  if (value["state"] === "ready") {
    const routes = readRoutes([value["route"]]);
    return routes?.length === 1 && routes[0]!.kind === "public" ? { state: "ready", route: routes[0]! } : { state: "failed" };
  }
  if (NEEDS_MAC(value)) return { state: "needs-mac", why: value["why"] as Extract<DoorOutcome, { state: "needs-mac" }>["why"] };
  return { state: "failed" };
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** One line of a 200 answer, as a phone reads it; null for a keepalive or a line it does not know. */
export function readDoorLine(text: string): DoorLine | null {
  const value = parse(text);
  if (!isRecord(value)) return null;
  if (value["t"] === "accepted") return { t: "accepted" };
  if (value["t"] === "done") return { t: "done", outcome: readOutcome(value["outcome"]) };
  return null;
}

const REASON = oneOf("denied", "expired", "door-outdated", "needs-mac");

/**
 * A refusal's body as a phone reads it, whatever else a later door adds: a reason this build does not know reads as
 * `unknown`. Null when the body is no door's refusal at all.
 */
export function readDoorRefusal(text: string): (Omit<DoorRefusal, "why"> & { why: DoorRefusalReason | "unknown" }) | null {
  const value = parse(text);
  if (!isRecord(value) || value["t"] !== "refused" || !whole(value["now"])) return null;
  return { t: "refused", why: REASON(value["why"]) ? (value["why"] as DoorRefusalReason) : "unknown", now: value["now"] as number };
}
