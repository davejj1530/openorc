import type { Route } from "@openorc/protocol";
import type { KeyPair, LinkCrypto } from "../crypto.js";
import { initiate } from "../noise.js";
import type { LinkSocket } from "../session.js";

/*
 * How phone builds already installed read a host's hello and a pairing code. They read keys exactly, so a field they do
 * not know locks them out of the host. Frozen on purpose: never change this to make a test pass; a host a build rejects
 * is one its phones cannot reach. The builds differ only in how they read routes:
 * - appStore: App Store 1.0.0 (202610270002), the link package as of 85bf1c5e. It knows lan and tailnet routes and
 *   refuses a whole hello or code that lists any other kind.
 * - testFlight: TestFlight 202610270003, as of 89a9ed15. It also knows public routes and drops kinds it does not know.
 */

type Check = (value: unknown) => boolean;
type Fields = Record<string, Check>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text =
  (max: number): Check =>
  (value) =>
    typeof value === "string" && value.length > 0 && value.length <= max;
const count: Check = (value) => Number.isSafeInteger(value) && (value as number) >= 0;
const present: Check = () => true;
const oneOf =
  (...values: string[]): Check =>
  (value) =>
    typeof value === "string" && values.includes(value);

function shape(required: Fields, optional: Fields = {}): Check {
  return (value) =>
    isRecord(value) &&
    Object.keys(value).every((key) => Object.hasOwn(required, key) || Object.hasOwn(optional, key)) &&
    Object.entries(required).every(([key, check]) => Object.hasOwn(value, key) && check(value[key])) &&
    Object.entries(optional).every(([key, check]) => !Object.hasOwn(value, key) || check(value[key]));
}

function variants(tag: string, table: Record<string, Check>): Check {
  return (value) => {
    if (!isRecord(value)) return false;
    const kind = value[tag];
    return typeof kind === "string" && Object.hasOwn(table, kind) && table[kind]!(value);
  };
}

const port: Check = (value) => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65_535;
const route = shape({ kind: present, host: text(253), port });

/** The routes a hello or code lists, as the build keeps them, or null where it refuses the whole message. */
type RouteReader = (value: unknown) => Route[] | null;

const appStoreRoute = shape({ kind: oneOf("lan", "tailnet"), host: text(253), port });
const appStoreRoutes: RouteReader = (value) => (Array.isArray(value) && value.length <= 32 && value.every(appStoreRoute) ? (value as Route[]) : null);

const ROUTE_KINDS = ["lan", "tailnet", "public"];
const testFlightRoutes: RouteReader = (value) => {
  if (!Array.isArray(value) || value.length > 32) return null;
  const routes: Route[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry["kind"] !== "string") return null;
    if (!ROUTE_KINDS.includes(entry["kind"])) continue;
    if (!route(entry)) return null;
    routes.push({ kind: entry["kind"] as Route["kind"], host: entry["host"] as string, port: entry["port"] as number });
  }
  return routes;
};

const message = (fields: Fields, optional?: Fields) => shape({ t: present, ...fields }, optional);
const macHello = variants("t", {
  hello: message({ version: count, mac: shape({ name: text(255) }), deviceId: text(64), routes: present }),
  refused: message({ reason: oneOf("unpaired", "offer-invalid", "incompatible", "busy") }),
});

function parseMacHello(value: unknown, readRoutes: RouteReader): Record<string, unknown> {
  if (!macHello(value)) throw new Error("not a Mac hello");
  const hello = value as Record<string, unknown>;
  if (hello["t"] === "refused") return hello;
  const routes = readRoutes(hello["routes"]);
  if (!routes) throw new Error("not a Mac hello");
  return { ...hello, routes };
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const INDEX = new Map([...ALPHABET].map((char, i) => [char, i]));

function fromBase64Url(text: string): Uint8Array {
  if (text.length % 4 === 1) throw new Error("not base64url");
  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of text) {
    const digit = INDEX.get(char);
    if (digit === undefined) throw new Error("not base64url");
    value = (value << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 255;
    }
  }
  if (value & ((1 << bits) - 1)) throw new Error("not base64url");
  return out;
}

const fromUtf8 = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const PREFIX = "openorc://pair#v1.";
const KEYS = ["name", "key", "offer", "secret", "routes", "expires"];
const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

function bytes(value: unknown, length: number): Uint8Array {
  if (typeof value !== "string") throw new Error("not a pairing code");
  const decoded = fromBase64Url(value);
  if (decoded.length !== length) throw new Error("not a pairing code");
  return decoded;
}

function decodePairingUrl(text: string, readRoutes: RouteReader) {
  if (!text.startsWith(PREFIX)) throw new Error("not a pairing code");
  const body: unknown = JSON.parse(fromUtf8(fromBase64Url(text.slice(PREFIX.length))));
  if (!isRecord(body)) throw new Error("not a pairing code");
  if (Object.keys(body).length !== KEYS.length || !KEYS.every((key) => Object.hasOwn(body, key))) throw new Error("not a pairing code");
  const { name, offer, expires } = body;
  const routes = readRoutes(body["routes"]);
  if (!isText(name, 255) || !isText(offer, 64) || !routes?.length || !Number.isSafeInteger(expires)) throw new Error("not a pairing code");
  return { macName: name, macKey: bytes(body["key"], 32), offerId: offer, secret: bytes(body["secret"], 32), routes, expiresAt: expires as number };
}

const installedPhone = (readRoutes: RouteReader) => ({
  /** Throws where the build refuses the hello. */
  parseMacHello: (value: unknown) => parseMacHello(value, readRoutes),
  /** Throws where the build says "This is not an OpenOrc pairing code." */
  decodePairingUrl: (text: string) => decodePairingUrl(text, readRoutes),
});

export const INSTALLED_PHONES = { appStore: installedPhone(appStoreRoutes), testFlight: installedPhone(testFlightRoutes) };

/** The host's hello as sent, unread: an installed phone's handshake on `socket`, which it then closes. */
export function rawMacHello(options: { socket: LinkSocket; crypto: LinkCrypto; device: KeyPair; macKey: Uint8Array; pair?: { offerId: string; secret: string } }): Promise<unknown> {
  const { socket } = options;
  const hello = { t: "hello", version: 1, device: { name: "Installed phone" }, ...(options.pair ? { pair: options.pair } : {}) };
  const handshake = initiate({
    crypto: options.crypto,
    prologue: new TextEncoder().encode("openorc-link/1"),
    local: options.device,
    remoteStatic: options.macKey,
    payload: new TextEncoder().encode(JSON.stringify(hello)),
  });
  return new Promise((resolve, reject) => {
    socket.onClose((code, reason) => reject(new Error(`closed before the hello: ${code} ${reason}`)));
    socket.onMessage((data) => {
      try {
        resolve(JSON.parse(fromUtf8(handshake.finish(data).payload)));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      } finally {
        socket.close(1000, "");
      }
    });
    socket.send(handshake.message);
  });
}
