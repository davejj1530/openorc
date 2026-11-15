import type { RemoteAccess } from "../remote/remote-access.js";
import type { Handlers } from "./types.js";

type RemoteMethods = Extract<keyof Handlers, `remote.${string}`>;

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
    "remote.push.setKey": ({ keyId, pem }) => remote.setPushKey(keyId, pem),
    "remote.push.removeKey": () => remote.removePushKey(),
    "remote.push.test": () => remote.testPush(),
  };
}
