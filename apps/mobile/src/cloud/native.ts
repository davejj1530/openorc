import type { KeptPart } from "@openorc/hosted";
import * as SecureStore from "expo-secure-store";
import { keychainKeys } from "../connection/native";
import type { CloudDeviceKey, CloudKeyStore } from "./cloud-alerts";
import type { CloudRecord, CloudVault } from "./phone-cloud";

// Readable after the first unlock, so the session holds through a background refresh; never leaves this phone.
const keychain: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const SESSION = "openorc.cloud.session";

/** The phone's own OpenOrc Cloud session in the Keychain, beside its keys for its Macs. */
export const keychainVault: CloudVault = {
  async load() {
    const text = await SecureStore.getItemAsync(SESSION, keychain);
    if (!text) return null;
    try {
      const record = JSON.parse(text) as Partial<CloudRecord>;
      return typeof record.server === "string" && typeof record.value === "string" ? { server: record.server, value: record.value } : null;
    } catch {
      return null;
    }
  },
  save: (record) => (record ? SecureStore.setItemAsync(SESSION, JSON.stringify(record), keychain) : SecureStore.deleteItemAsync(SESSION, keychain)),
};

const PARTS: readonly KeptPart[] = ["account", "threads", "spaces", "organizationBilling", "seatOperations", "seatQuantity"];

/** What the phone's cloud keeps for a cold start, in the app's own store, under its own names, and forgotten with the session. */
export function keptIn(store: { getString(key: string): string | undefined; set(key: string, value: string): void; remove(key: string): void }) {
  const key = (part: KeptPart) => `cloud.kept.${part}`;
  return {
    load: (part: KeptPart) => store.getString(key(part)) ?? null,
    save: (part: KeptPart, json: string | null) => (json === null ? store.remove(key(part)) : store.set(key(part), json)),
    forget: () => PARTS.forEach((part) => store.remove(key(part))),
  };
}

const DEVICE = "openorc.cloud.device";

/**
 * This phone's key for its account server's alerts, in the Keychain, and filed as `device-key.<sender key>`, the item
 * the notification extension reads for whoever sealed an alert, as it does for a Mac.
 */
export const cloudKeys: CloudKeyStore = {
  async load() {
    const text = await SecureStore.getItemAsync(DEVICE, keychain);
    if (!text) return null;
    try {
      return JSON.parse(text) as CloudDeviceKey;
    } catch {
      return null;
    }
  },
  save: (key) => (key ? SecureStore.setItemAsync(DEVICE, JSON.stringify(key), keychain) : SecureStore.deleteItemAsync(DEVICE, keychain)),
  // The same item as a Mac's key for this phone, which is where the extension looks for whoever sealed an alert.
  file: (sender, privateKey) => keychainKeys.write(sender, privateKey),
  unfile: (sender) => keychainKeys.remove(sender),
};
