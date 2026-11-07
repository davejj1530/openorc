import { ROUTE_KINDS, type Route } from "@openorc/protocol";
import { concat, toBase64Url, utf8 } from "./bytes.js";
import { isRecord, present, shape, text, type Check } from "./checks.js";
import type { LinkCrypto } from "./crypto.js";

/** The path lan and tailnet routes are served on, which phones and Macs in the field already speak. */
export const LINK_PATH = "/link/1";
const PUBLIC_TAG_LABEL = utf8("openorc-link/public-path/1");
const PUBLIC_TAG_BYTES = 16;
const MAX_ROUTES = 32;

/** lan and tailnet reach the listener itself, where Noise is the only encryption; public goes through a TLS proxy. */
const DIALS: Record<Route["kind"], "direct" | "proxied"> = { lan: "direct", tailnet: "direct", public: "proxied" };

/**
 * The path a host serves a route kind on, and the one a phone dials. A public route's path ends in a tag derived from
 * the host's static key, so only someone holding the key a pairing code carries reaches the upgrade. Everyone else
 * hears 404 before any handshake slot or budget is spent. The tag does not reveal the key.
 */
export function linkPath(kind: Route["kind"], hostKey: Uint8Array, crypto: Pick<LinkCrypto, "sha256">): string {
  if (DIALS[kind] === "direct") return LINK_PATH;
  const tag = crypto.sha256(concat(PUBLIC_TAG_LABEL, hostKey)).subarray(0, PUBLIC_TAG_BYTES);
  return `${LINK_PATH}/${toBase64Url(tag)}`;
}

/** Where a phone dials a route. The proxy's port is left out when it is 443, which App Transport Security expects. */
export function linkUrl(route: Route, hostKey: Uint8Array, crypto: Pick<LinkCrypto, "sha256">): string {
  const host = route.host.includes(":") ? `[${route.host}]` : route.host;
  const path = linkPath(route.kind, hostKey, crypto);
  if (DIALS[route.kind] === "direct") return `ws://${host}:${route.port}${path}`;
  return `wss://${host}${route.port === 443 ? "" : `:${route.port}`}${path}`;
}

const isRouteKind = (kind: string): kind is Route["kind"] => (ROUTE_KINDS as readonly string[]).includes(kind);
const port: Check = (value) => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65_535;
const route = shape({ kind: present, host: text(253), port });

/**
 * The routes in a list the other end sent, in its order. An entry of a kind this build does not know is skipped,
 * whatever else it holds, so a host can add a kind later without breaking phones built before it. Null when the list,
 * an entry, or a route of a known kind is malformed.
 */
export function readRoutes(value: unknown): Route[] | null {
  if (!Array.isArray(value) || value.length > MAX_ROUTES) return null;
  const routes: Route[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry["kind"] !== "string") return null;
    if (!isRouteKind(entry["kind"])) continue;
    if (!route(entry)) return null;
    routes.push({ kind: entry["kind"], host: entry["host"] as string, port: entry["port"] as number });
  }
  return routes;
}
