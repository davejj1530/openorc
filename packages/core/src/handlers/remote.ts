import type { RemoteAccess } from "../remote/remote-access.js";
import type { Handlers } from "./types.js";

type RemoteMethods = Extract<keyof Handlers, `remote.${string}`>;

/** `pushKeyChanged`: the cloud brain sends its own alerts with this host's push key, so it takes each new one. */
export function createRemoteHandlers({ remote, pushKeyChanged }: { remote: RemoteAccess; pushKeyChanged: () => void }): Pick<Handlers, RemoteMethods> {
  const changing = async <T>(work: Promise<T>): Promise<T> => {
    const result = await work;
    pushKeyChanged();
    return result;
  };
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
    "remote.push.setKey": ({ keyId, pem }) => changing(remote.setPushKey(keyId, pem)),
    "remote.push.removeKey": () => changing(remote.removePushKey()),
    "remote.push.test": () => remote.testPush(),
  };
}
