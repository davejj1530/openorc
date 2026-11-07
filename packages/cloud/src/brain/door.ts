import { createHmac, hkdfSync } from "node:crypto";
import type { BrainKey, DoorConfig } from "./wire.js";

/**
 * What the brain key says about the brain's door, the small function in the person's Vercel team that a paired phone
 * knocks on to wake the brain. The Mac, the brain and the door each derive the same values from the key; nothing
 * stores them, so the door's address and the phones' tickets never need syncing.
 */

/** The door's own project, apart from the brain's, so its function and secrets come and go without the brain's sandboxes. */
export const DOOR_PROJECT = "openorc-door";
/** One ticket epoch. A ticket holds in its epoch and the next, so a phone that stops meeting its host falls off in 30 to 60 days. */
export const DOOR_EPOCH_MS = 30 * 24 * 60 * 60_000;
/** How far ahead a ticket's epoch may be, for a brain whose clock runs a little ahead of the door's at an epoch's turn. */
const AHEAD_MS = 10 * 60_000;
const SALT = "openorc-brain door/1";
const HOST_CHARS = 16;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** A phone's key, as the device method hands it over: the ticket in base64url. */
export interface BrainDoorKey {
  host: string;
  device: string;
  epoch: number;
  ticket: string;
}

export interface BrainDoor {
  /** `openorc-door-<16 base32>.vercel.app`, the same for this key forever. */
  readonly host: string;
  /** A phone's ticket for one epoch. */
  ticket(device: string, epoch: number): Uint8Array;
  /** What a phone gets on each session: this epoch's ticket for its own device id. */
  key(device: string, now: number): BrainDoorKey;
  /** 22 base64url characters naming a config with the code and deploy shape it went out with; says nothing of either. */
  mark(release: string, shape: unknown, config: Omit<DoorConfig, "mark">): string;
}

export const doorEpoch = (now: number): number => Math.floor(now / DOOR_EPOCH_MS);

/** How a knock's epoch stands at the door now: one it takes, one too old, or one no brain could have issued yet. */
export function ticketStanding(epoch: number, now: number): "good" | "expired" | "ahead" {
  if (epoch > doorEpoch(now + AHEAD_MS)) return "ahead";
  return epoch >= doorEpoch(now) - 1 ? "good" : "expired";
}

function base32(bytes: Uint8Array, chars: number): string {
  let out = "";
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      bits -= 5;
      out += BASE32[(value >> bits) & 31];
    }
  }
  return out;
}

export function brainDoor(brainKey: BrainKey): BrainDoor {
  const doorKey = Buffer.from(hkdfSync("sha256", brainKey, SALT, "door", 32));
  const hmac = (text: string) => createHmac("sha256", doorKey).update(text, "utf8").digest();
  const host = `openorc-door-${base32(hmac("host"), HOST_CHARS)}.vercel.app`;
  const ticket = (device: string, epoch: number) => new Uint8Array(hmac(`ticket\n${epoch}\n${device}`));
  return {
    host,
    ticket,
    key: (device, now) => {
      const epoch = doorEpoch(now);
      return { host, device, epoch, ticket: Buffer.from(ticket(device, epoch)).toString("base64url") };
    },
    mark: (release, shape, { key: _key, ...config }) =>
      hmac(`mark\n${JSON.stringify({ release, shape, config })}`)
        .subarray(0, 16)
        .toString("base64url"),
  };
}
