import type { Route } from "@openorc/protocol";

/** A Mac this phone paired with. */
export interface SavedMac {
  /** The Mac's static key, base64url: pinned when the code was scanned, and how this phone tells its Macs apart. */
  id: string;
  name: string;
  /** How the Mac said it can be reached, in its order, then older ones it has not listed since. */
  routes: Route[];
  /** The route the last session used. It goes first while it suits the network. */
  lastRoute: Route | null;
}

/** The saved Macs and which one the app shows. Synchronous, so Home can paint before anything connects. */
export interface MacStore {
  list(): SavedMac[];
  activeId(): string | null;
  setActiveId(id: string | null): void;
  save(mac: SavedMac): void;
  remove(id: string): void;
}

/** This phone's private key for each Mac: one pair per Mac, so one Mac removing the phone never touches another. */
export interface DeviceKeys {
  read(macId: string): Promise<Uint8Array | null>;
  write(macId: string, privateKey: Uint8Array): Promise<void>;
  remove(macId: string): Promise<void>;
}

export type NetworkKind = "wifi" | "cellular" | "none" | "other";

const MAX_ROUTES = 8;

export const sameRoute = (a: Route, b: Route) => a.kind === b.kind && a.host === b.host && a.port === b.port;

/**
 * The routes worth trying on this network, in order. LAN addresses only answer on the Mac's own network, so on
 * cellular only the tailnet is tried; elsewhere LAN goes first, as it is faster. The last route that worked leads its
 * kind.
 */
export function routesFor(mac: Pick<SavedMac, "routes" | "lastRoute">, network: NetworkKind): Route[] {
  if (network === "none") return [];
  const last = mac.lastRoute;
  const ordered = last && mac.routes.some((route) => sameRoute(route, last)) ? [last, ...mac.routes.filter((route) => !sameRoute(route, last))] : mac.routes;
  const tailnet = ordered.filter((route) => route.kind === "tailnet");
  return network === "cellular" ? tailnet : [...ordered.filter((route) => route.kind === "lan"), ...tailnet];
}

/** What the Mac listed in its hello, which reflects its addresses now, then saved routes it left out. */
export function learnRoutes(saved: readonly Route[], heard: readonly Route[]): Route[] {
  const merged = [...heard];
  for (const route of saved) if (!merged.some((known) => sameRoute(known, route))) merged.push(route);
  return merged.slice(0, MAX_ROUTES);
}
