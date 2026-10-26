import type { KeyValue } from "../scratch-store";

/** Where a Mac's Home folds are kept on the phone. */
export const foldsKey = (macId: string) => `home.collapsed.${macId}`;

/** Deletes a forgotten Mac's folds. */
export function forgetFolds(store: Pick<KeyValue, "remove">, macId: string): void {
  store.remove(foldsKey(macId));
}
