import { fromBase64Url, toBase64Url } from "@openorc/link";
import { nobleCrypto } from "@openorc/link/test-fixtures/noble-crypto";
import type { PushRegistration } from "@openorc/protocol";
import { expect, it } from "vitest";
import { CloudAlerts, type CloudDeviceKey, type DeviceRegistry } from "./cloud-alerts";

/*
 * The phone registers for its own OpenOrc Cloud's alerts under a key of its own, and files that key under the server's
 * so the extension opens what the server sealed. A server with no Apple key yet says so, and that is all.
 */

const SERVER = "https://api.example";
const serverKey = toBase64Url(nobleCrypto.generateKeyPair().publicKey);
const wanted: PushRegistration = { token: "ab".repeat(32), environment: "production", alerts: "all", sound: true };

function world() {
  const stored = { key: null as CloudDeviceKey | null };
  const filed = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const at = { held: true as boolean, server: SERVER, registration: wanted as PushRegistration | null, sender: "no-key" as "ready" | "no-key", serverKey };
  const registry: DeviceRegistry = {
    registerDevice: async (id, registration) => {
      calls.push(`put ${stored.key && id === toBase64Url(nobleCrypto.keyPairFromPrivate(fromBase64Url(stored.key.privateKey)).publicKey) ? "own key" : "another key"} ${registration.alerts}`);
      return { sender: at.sender, publicKey: at.serverKey };
    },
    removeDevice: async () => void calls.push("delete"),
  };
  const make = () =>
    new CloudAlerts({
      crypto: nobleCrypto,
      keys: {
        load: async () => stored.key,
        save: async (key) => void (stored.key = key),
        file: async (sender, privateKey) => void filed.set(sender, privateKey),
        unfile: async (sender) => void filed.delete(sender),
      },
      held: () => (at.held ? { server: at.server, registry } : null),
      registration: () => at.registration,
      warn: (message) => void calls.push(`warn ${message}`),
    });
  return { stored, filed, calls, at, make };
}

it("registers under a key of its own, filed under the server's key where the extension finds it, and keeps it across launches", async () => {
  const phone = world();
  const alerts = phone.make();
  await alerts.sync();
  expect(phone.calls).toEqual(["put own key all"]);
  expect(alerts.senderKey()).toBe(serverKey);
  expect(alerts.senderState()).toBe("no-key");
  const filed = phone.filed.get(serverKey)!;
  expect(toBase64Url(nobleCrypto.keyPairFromPrivate(filed).privateKey)).toBe(phone.stored.key!.privateKey);
  // A relaunch registers again under the same key.
  const again = phone.make();
  await again.sync();
  expect(phone.calls).toEqual(["put own key all", "put own key all"]);
  expect(phone.stored.key!.privateKey).toBe(toBase64Url(filed));
});

it("takes itself off when alerts are turned off, and on again under the same key", async () => {
  const phone = world();
  const alerts = phone.make();
  await alerts.sync();
  const first = phone.stored.key!.privateKey;
  phone.at.registration = null;
  await alerts.sync();
  expect(phone.calls.at(-1)).toBe("delete");
  expect(alerts.senderKey()).toBeNull();
  phone.at.registration = { ...wanted, alerts: "needs-you" };
  await alerts.sync();
  expect(phone.calls.at(-1)).toBe("put own key needs-you");
  expect(phone.stored.key!.privateKey).toBe(first);
});

it("forgets its key when the session goes or is another server's, and re-files it when the server's key changes", async () => {
  const phone = world();
  const alerts = phone.make();
  await alerts.sync();
  const rotated = toBase64Url(nobleCrypto.generateKeyPair().publicKey);
  phone.at.serverKey = rotated;
  await alerts.sync();
  expect([...phone.filed.keys()]).toEqual([rotated]);
  phone.at.held = false;
  await alerts.sync();
  expect(phone.filed.size).toBe(0);
  expect(phone.stored.key).toBeNull();
  expect(alerts.senderKey()).toBeNull();
  phone.at.held = true;
  phone.at.server = "https://another.example";
  await alerts.sync();
  expect(phone.stored.key!.server).toBe("https://another.example");
  expect(fromBase64Url(phone.stored.key!.privateKey)).toHaveLength(32);
});
