import { CLOUD_SESSION, CLOUD_SESSION_TAG, type DeviceMethod, type DeviceParams, type DeviceRpcResults } from "@openorc/protocol";
import type { ClientPush } from "@openorc/client";
import { showsDemo, type LinkState } from "../connection/manager";
import { PHONE_DEVICE, type CloudSource } from "./phone-cloud";

/** The link as following the Mac's account reads it. */
export interface FollowedLink {
  getState(): LinkState;
  subscribe(listener: () => void): () => void;
  connection: {
    shares(capability: string): Promise<boolean>;
    device<M extends DeviceMethod>(method: M, params: DeviceParams<M>): Promise<DeviceRpcResults[M]>;
    onPush(listener: (push: ClientPush) => void): () => void;
  };
}

/** The phone's cloud as the link drives it: taken from a Mac, and let go with no Mac to take it from. */
export interface FollowingCloud {
  follow(source: CloudSource): Promise<void>;
  release(): Promise<void>;
}

/**
 * Keeps the phone's own OpenOrc Cloud the shown Mac's person's: asked on each new session with a Mac that gets phones
 * a session of their own, and again whenever that Mac says its account changed; let go once the phone has no Mac. A Mac
 * too old to say, a dropped session or the demo leaves the session as it is.
 */
export function followMac(link: FollowedLink, cloud: FollowingCloud, warn: (message: string) => void): () => void {
  const source: CloudSource = {
    owner: () => link.connection.device("cloud.session.owner", {}),
    grant: (challenge) => link.connection.device("cloud.session.grant", { challenge, device: PHONE_DEVICE }),
  };
  const ask = async () => {
    if (!(await link.connection.shares(CLOUD_SESSION))) return;
    await cloud.follow(source).catch((error: unknown) => warn(`The phone's cloud was not taken from its Mac: ${error instanceof Error ? error.message : String(error)}`));
  };
  let serial: number | null = null;
  const changed = () => {
    const state = link.getState();
    if (state.kind === "unpaired") {
      serial = null;
      void cloud.release();
      return;
    }
    if (state.kind !== "connected" || showsDemo(state) || state.serial === serial) return;
    serial = state.serial;
    void ask();
  };
  const unsubscribe = link.subscribe(changed);
  const unheard = link.connection.onPush((push) => {
    if (push.type === "invalidate" && push.keys.includes(CLOUD_SESSION_TAG) && !showsDemo(link.getState())) void ask();
  });
  changed();
  return () => {
    unsubscribe();
    unheard();
  };
}
