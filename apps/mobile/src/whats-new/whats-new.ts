import { whatsNewDue } from "@openorc/client";
import type { KeyValue } from "../scratch-store";

/** The first phone version with OpenOrc Cloud: the one after 1.2.0, the last without it. */
export const PHONE_CLOUD_RELEASE = "1.3.0";

/**
 * The release this bundle is. An over-the-air update brings it to a phone whose store version stays what it was, so
 * the steps key on it, not on the store's: raise it with each release that brings steps.
 */
export const BUNDLE_RELEASE = "1.3.0";

const SEEN = "seen";

/** The steps on what an update brought, for this launch: `take` says once whether they are due, `close` settles them. */
export interface WhatsNew {
  take(): boolean;
  close(): void;
}

/**
 * Whether this launch is due the steps on what the update brought, from the bundle's release running, the version this phone
 * last settled them for, and whether it had a Mac paired before this launch: a phone that was in use, not a fresh
 * install, whose pairing comes first. A launch they are not due to is settled at once.
 */
export function whatsNewAtLaunch(store: KeyValue, running: string, pairedBefore: boolean): WhatsNew {
  const settle = () => store.set(SEEN, running);
  let due = whatsNewDue({ release: PHONE_CLOUD_RELEASE, running, seen: store.getString(SEEN) ?? null, onboarded: pairedBefore });
  if (!due) settle();
  return {
    take() {
      const taken = due;
      due = false;
      return taken;
    },
    close: settle,
  };
}
