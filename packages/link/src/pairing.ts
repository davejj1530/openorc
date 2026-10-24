import type { Route } from "@openorc/protocol";
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from "./bytes.js";
import { KEY_BYTES } from "./crypto.js";

/** What a pairing QR code carries. The phone pins `macKey` for good; `secret` is spent by the first handshake. */
export interface PairingOffer {
  macName: string;
  macKey: Uint8Array;
  offerId: string;
  secret: Uint8Array;
  routes: Route[];
  expiresAt: number;
}

// A fragment, so nothing that opens the code as a link sends the secret anywhere.
const PREFIX = "openorc://pair#v1.";
export const PAIRING_SECRET_BYTES = 32;
const KEYS = ["name", "key", "offer", "secret", "routes", "expires"];

export class PairingCodeError extends Error {
  constructor() {
    super("This is not an OpenOrc pairing code.");
  }
}

export function encodePairingUrl(offer: PairingOffer): string {
  const body = {
    name: offer.macName,
    key: toBase64Url(offer.macKey),
    offer: offer.offerId,
    secret: toBase64Url(offer.secret),
    routes: offer.routes.map(({ kind, host, port }) => ({ kind, host, port })),
    expires: offer.expiresAt,
  };
  return PREFIX + toBase64Url(utf8(JSON.stringify(body)));
}

const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

function route(value: unknown): Route {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PairingCodeError();
  const { kind, host, port, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length || (kind !== "lan" && kind !== "tailnet") || !isText(host, 253) || !Number.isInteger(port) || (port as number) < 1 || (port as number) > 65_535)
    throw new PairingCodeError();
  return { kind, host, port: port as number };
}

function bytes(value: unknown, length: number): Uint8Array {
  if (typeof value !== "string") throw new PairingCodeError();
  try {
    const decoded = fromBase64Url(value);
    if (decoded.length === length) return decoded;
  } catch {
    // Reported as the code being foreign, below.
  }
  throw new PairingCodeError();
}

/** Throws PairingCodeError on anything that is not a well-formed v1 code. Expiry is the caller's to compare. */
export function decodePairingUrl(text: string): PairingOffer {
  if (!text.startsWith(PREFIX)) throw new PairingCodeError();
  let body: unknown;
  try {
    body = JSON.parse(fromUtf8(fromBase64Url(text.slice(PREFIX.length))));
  } catch {
    throw new PairingCodeError();
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new PairingCodeError();
  const fields = body as Record<string, unknown>;
  if (Object.keys(fields).length !== KEYS.length || !KEYS.every((key) => Object.hasOwn(fields, key))) throw new PairingCodeError();
  const { name, key, offer, secret, routes, expires } = fields;
  if (!isText(name, 255) || !isText(offer, 64) || !Array.isArray(routes) || routes.length === 0 || routes.length > 32 || !Number.isSafeInteger(expires)) throw new PairingCodeError();
  return { macName: name, macKey: bytes(key, KEY_BYTES), offerId: offer, secret: bytes(secret, PAIRING_SECRET_BYTES), routes: routes.map(route), expiresAt: expires as number };
}
