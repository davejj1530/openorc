import { encodePairingUrl } from "../../packages/link/src/pairing";
import type { PairingOfferView, RemoteDevice, RemoteListener, RemoteStatus, Route } from "@openorc/protocol";

const routes: Route[] = [
  { kind: "lan", host: "studio-mac.local", port: 47820 },
  { kind: "lan", host: "192.168.1.24", port: 47820 },
  { kind: "tailnet", host: "studio-mac.tail4c2e.ts.net", port: 47820 },
  { kind: "tailnet", host: "100.101.102.103", port: 47820 },
];

/**
 * Session-only phone access for the design preview. `?phone=off` starts with access off and nothing paired,
 * `?phone=failed` with a listener that could not start; otherwise access is on with two paired phones. Nothing
 * listens, and the pairing code carries a fixed key and secret.
 */
export function createDesignRemoteRpc(start: string | null) {
  const now = Date.now();
  let listener: RemoteListener = listenerFor(start);
  let devices: RemoteDevice[] =
    start === "off"
      ? []
      : [
          { id: "iphone", name: "David’s iPhone", createdAt: now - 6 * 86_400_000, lastSeenAt: now - 60_000, connected: true },
          { id: "ipad", name: "Studio iPad", createdAt: now - 20 * 86_400_000, lastSeenAt: now - 3 * 3_600_000, connected: false },
        ];
  let offer: PairingOfferView | null = null;
  let offers = 0;
  const status = (): RemoteStatus => ({
    listener,
    devices: structuredClone(devices),
    pairing: offer && Date.now() < offer.expiresAt ? { offerId: offer.offerId, expiresAt: offer.expiresAt } : null,
  });
  return (method: string, params: Record<string, unknown>): unknown => {
    if (method === "remote.status") return status();
    if (method === "remote.configure") {
      listener = listenerFor(params.enabled ? "on" : "off");
      if (!params.enabled) offer = null;
      return status();
    }
    if (method === "remote.pairing.begin") {
      offers += 1;
      const expiresAt = Date.now() + 5 * 60_000;
      const offerId = `preview-offer-${offers}`;
      const bytes = (seed: number) => Uint8Array.from({ length: 32 }, (_, i) => (seed + i * 37) % 256);
      offer = { offerId, expiresAt, url: encodePairingUrl({ macName: "studio-mac", macKey: bytes(11), offerId, secret: bytes(offers), routes, expiresAt }) };
      return offer;
    }
    if (method === "remote.pairing.cancel") {
      if (offer?.offerId === params.offerId) offer = null;
      return null;
    }
    if (method === "remote.devices.remove") {
      devices = devices.filter((device) => device.id !== params.id);
      return null;
    }
    return undefined;
  };
}

function listenerFor(start: string | null): RemoteListener {
  if (start === "off") return { state: "off" };
  if (start === "failed") return { state: "failed", reason: "Port 47820 is in use by another app." };
  return { state: "on", port: 47820, routes };
}
