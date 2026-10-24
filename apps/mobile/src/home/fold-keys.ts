import type { MMKV } from "react-native-mmkv";

/** Where a Mac's Home folds are kept on the phone. */
export const foldsKey = (macId: string) => `home.collapsed.${macId}`;

/** Deletes a forgotten Mac's folds. */
export function forgetFolds(store: Pick<MMKV, "remove">, macId: string): void {
  store.remove(foldsKey(macId));
}
