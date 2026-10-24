import { createNodeStyleCrypto, fromBase64Url, LinkCloseCode, toBase64Url, type LinkSocket } from "@openorc/link";
import type { Route } from "@openorc/protocol";
import * as SecureStore from "expo-secure-store";
import type { MMKV } from "react-native-mmkv";
import QuickCrypto, { type KeyObject } from "react-native-quick-crypto";
import type { OpeningSocket } from "./manager";
import type { Clock } from "./route-race";
import type { DeviceKeys, MacStore, SavedMac } from "./saved-macs";

/** The link's crypto on the phone: OpenSSL through react-native-quick-crypto, which boot installs. */
export const phoneCrypto = createNodeStyleCrypto<KeyObject>({
  ...QuickCrypto,
  // Without a callback it answers at once; its type also covers the callback form.
  diffieHellman(keys) {
    const secret = QuickCrypto.diffieHellman(keys);
    if (!secret) throw new Error("Key agreement failed.");
    return secret;
  },
});

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A React Native WebSocket to the Mac's link endpoint, as a session uses it. */
export function openSocket(route: Route): OpeningSocket {
  const host = route.host.includes(":") ? `[${route.host}]` : route.host;
  const ws = new WebSocket(`ws://${host}:${route.port}/link/1`);
  ws.binaryType = "arraybuffer";
  let onMessage: (data: Uint8Array) => void = () => undefined;
  let onClose: (code: number, reason: string) => void = () => undefined;
  const socket: LinkSocket = {
    send: (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    bufferedAmount: () => ws.bufferedAmount ?? 0,
    close: (code, reason) => ws.close(code, reason.slice(0, 120)),
    onMessage: (listener) => (onMessage = listener),
    onClose: (listener) => (onClose = listener),
  };
  const opened = new Promise<LinkSocket>((resolve, reject) => {
    ws.onopen = () => resolve(socket);
    ws.onerror = () => reject(new Error("The socket failed."));
    ws.onclose = (event) => {
      reject(new Error("The socket closed."));
      onClose(event.code, event.reason);
    };
  });
  ws.onmessage = (event: MessageEvent<unknown>) => {
    if (event.data instanceof ArrayBuffer) onMessage(new Uint8Array(event.data));
    else ws.close(LinkCloseCode.protocol, "binary messages only");
  };
  return { opened, close: () => ws.close(LinkCloseCode.normal, "") };
}

const MACS = "macs";
const ACTIVE = "macs.active";

function readMacs(storage: MMKV): SavedMac[] {
  try {
    const value: unknown = JSON.parse(storage.getString(MACS) ?? "[]");
    return Array.isArray(value) ? (value as SavedMac[]) : [];
  } catch {
    return [];
  }
}

/** Saved Macs in MMKV, which reads synchronously, so the first frame already knows them. */
export function storedMacs(storage: MMKV): MacStore {
  const write = (macs: SavedMac[]) => storage.set(MACS, JSON.stringify(macs));
  return {
    list: () => readMacs(storage),
    activeId: () => storage.getString(ACTIVE) ?? null,
    setActiveId: (id) => (id ? storage.set(ACTIVE, id) : storage.remove(ACTIVE)),
    save: (mac) => {
      const macs = readMacs(storage);
      const index = macs.findIndex((saved) => saved.id === mac.id);
      if (index === -1) macs.push(mac);
      else macs[index] = mac;
      write(macs);
    },
    remove: (id) => write(readMacs(storage).filter((mac) => mac.id !== id)),
  };
}

// Readable after the first unlock, so a reconnect in the background works; never leaves this phone.
const keychain: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const keyName = (macId: string) => `device-key.${macId}`;

/** This phone's private key for each Mac, in the Keychain. */
export const keychainKeys: DeviceKeys = {
  async read(macId) {
    const text = await SecureStore.getItemAsync(keyName(macId), keychain);
    return text ? fromBase64Url(text) : null;
  },
  write: (macId, privateKey) => SecureStore.setItemAsync(keyName(macId), toBase64Url(privateKey), keychain),
  remove: (macId) => SecureStore.deleteItemAsync(keyName(macId), keychain),
};
