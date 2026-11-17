import type { KeyValue } from "../scratch-store";

/** Where a Mac's unticked workspaces are kept, by space. Apart from filter.ts, which reads the client at load. */
export const hiddenKey = (macId: string) => `home.hidden.${macId}`;

/** Forgets a Mac's unticked workspaces with the Mac. */
export function forgetHidden(storage: Pick<KeyValue, "remove">, macId: string): void {
  storage.remove(hiddenKey(macId));
}
