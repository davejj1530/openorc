import type { RemoteAccess } from "../remote/remote-access.js";
import type { Handlers } from "./types.js";

type RemoteMethods = "remote.status" | "remote.configure" | "remote.pairing.begin" | "remote.pairing.cancel" | "remote.devices.remove";

export function createRemoteHandlers({ remote }: { remote: RemoteAccess }): Pick<Handlers, RemoteMethods> {
  return {
    "remote.status": () => remote.status(),
    "remote.configure": ({ enabled }) => remote.configure(enabled),
    "remote.pairing.begin": () => remote.beginPairing(),
    "remote.pairing.cancel": ({ offerId }) => {
      remote.cancelPairing(offerId);
      return null;
    },
    "remote.devices.remove": ({ id }) => {
      remote.removeDevice(id);
      return null;
    },
  };
}
