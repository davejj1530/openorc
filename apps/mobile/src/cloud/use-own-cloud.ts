import { useSyncExternalStore } from "react";
import { cloud } from "../client";

/** Whether the phone holds a session of OpenOrc Cloud of its own now, and so reads the cloud itself, not through its Mac. */
export function useOwnCloud(): boolean {
  return useSyncExternalStore(cloud.subscribe, () => cloud.holds);
}
