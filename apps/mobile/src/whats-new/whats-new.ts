import { whatsNewDue } from "@openorc/client";
import type { KeyValue } from "../scratch-store";

/** The first phone version with OpenOrc Cloud: the one after 1.2.0, the last without it. */
export const PHONE_CLOUD_RELEASE = "1.3.0";

const SEEN = "seen";

/** The steps on what an update brought, for this launch: `take` says once whether they are due, `close` settles them. */
export interface WhatsNew {
  take(): boolean;
  close(): void;
}

/**
 * Whether this launch is due the steps on what the update brought, from the version running, the version this phone
 * last settled them for, and whether it had a Mac paired before this launch: a phone that was in use, not a fresh
 * install, whose pairing comes first. A launch they are not due to is settled at once.
 */
export function whatsNewAtLaunch(store: KeyValue, running: string | null, pairedBefore: boolean): WhatsNew {
  const settle = () => running && store.set(SEEN, running);
  let due = running !== null && whatsNewDue({ release: PHONE_CLOUD_RELEASE, running, seen: store.getString(SEEN) ?? null, onboarded: pairedBefore });
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
