import { getIpAddressAsync } from "expo-network";

const PRIVATE_V4 = /^(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d+\.\d+$/;
let primed = false;

/**
 * Raises iOS's Local Network prompt once, before a pairing dial can race it: one throwaway dial to the usual router
 * address of this Wi-Fi network, closed a moment later. Dials made while the prompt is up fail. Off a private network
 * (cellular, say) it dials nothing and waits for a later call on Wi-Fi.
 */
export function primeLocalNetwork(): void {
  if (primed) return;
  void getIpAddressAsync().then(
    (address) => {
      if (primed || !PRIVATE_V4.test(address)) return;
      primed = true;
      const ws = new WebSocket(`ws://${address.replace(/\.\d+$/, ".1")}:9/`);
      setTimeout(() => ws.close(), 1_000);
    },
    () => undefined,
  );
}
