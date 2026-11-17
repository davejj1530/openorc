import type { Hosted } from "@openorc/hosted";
import { standIn, type StandIn } from "@openorc/hosted/testing";
import type { PushEnvelope } from "@openorc/link";
import { nobleCrypto } from "@openorc/link/test-fixtures/noble-crypto";
import type { PushRegistration } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { noticeOpener, openTap } from "../notifications/taps";
import { CloudAlerts, type CloudDeviceKey } from "./cloud-alerts";
import { accountOn } from "./test-fixtures/stand-in-account";

/*
 * The phone's alerts about its own OpenOrc Cloud threads, against the stand-in's push routes and its Apple: registered
 * under the phone's own key, sealed by the server for that key, opened with the key the phone filed under the server's,
 * and a tap opening the cloud thread with no Mac. A server with no Apple key yet sends nothing, and says only that.
 */

const RILEY = "riley@example.com";
const wanted: PushRegistration = { token: "cd".repeat(32), environment: "production", alerts: "all", sound: true };

let stand: StandIn;
let hosted: Hosted;
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  hosted = await accountOn(stand, RILEY);
});
afterEach(async () => {
  hosted.close();
  await stand.close();
});

function phone() {
  const filed = new Map<string, Uint8Array>();
  const stored = { key: null as CloudDeviceKey | null };
  const warned: string[] = [];
  const alerts = new CloudAlerts({
    crypto: nobleCrypto,
    keys: {
      load: async () => stored.key,
      save: async (key) => void (stored.key = key),
      file: async (sender, privateKey) => void filed.set(sender, privateKey),
      unfile: async (sender) => void filed.delete(sender),
    },
    held: () => (hosted.account.status().state === "signed-in" ? { server: stand.url, registry: hosted.account } : null),
    registration: () => wanted,
    warn: (message) => void warned.push(message),
  });
  return { alerts, filed, warned, open: noticeOpener(nobleCrypto, async (sender) => filed.get(sender) ?? null) };
}

it("registers with a server that has no Apple key yet, hears only that, and gets nothing", async () => {
  const device = phone();
  await device.alerts.sync();
  expect(stand.push.devices(RILEY)).toHaveLength(1);
  expect(device.alerts.senderState()).toBe("no-key");
  expect(device.warned).toEqual([]);
  await stand.push.alert(RILEY, { kind: "finished", threadId: "t", title: "Pricing page layout", body: "Done." });
  expect(stand.push.pushed).toEqual([]);
});

it("opens what the server sealed with the key it filed under the server's, and a tap opens the cloud thread", async () => {
  stand.push.sender = "ready";
  const device = phone();
  await device.alerts.sync();
  expect(device.alerts.senderKey()).toBe(stand.push.publicKey);
  await stand.push.alert(RILEY, { kind: "finished", threadId: "cloud-thread", title: "Pricing page layout", body: "Three columns at 1040 px and up." });
  const [sent] = stand.push.pushed;
  expect(sent).toMatchObject({ token: wanted.token, payload: { aps: { alert: { body: "New activity in OpenOrc Cloud" } }, o: { m: stand.push.publicKey } } });
  const notice = await device.open(sent!.payload.o.m, sent!.payload.o as PushEnvelope);
  expect(notice).toMatchObject({ kind: "finished", threadId: "cloud-thread", title: "Pricing page layout", body: "Three columns at 1040 px and up." });
  const steps: string[] = [];
  await openTap(
    {
      route: { macId: sent!.payload.o.m, id: notice!.id, kind: "finished", threadId: "cloud-thread", o: sent!.payload.o as PushEnvelope },
      answer: null,
      shown: { title: notice!.title, subtitle: null, body: notice!.body },
    },
    {
      macs: () => [{ id: "studio" }],
      cloudSender: () => device.alerts.senderKey(),
      select: (id) => void steps.push(`select ${id}`),
      openThread: (id) => void steps.push(`open ${id}`),
      open: device.open,
      now: Date.now,
    },
  );
  expect(steps).toEqual(["open cloud-thread"]);
});

it("is forgotten by the server with its session, and forgets its key with it", async () => {
  stand.push.sender = "ready";
  const device = phone();
  await device.alerts.sync();
  await hosted.account.signOut();
  await vi.waitFor(() => expect(stand.push.devices(RILEY)).toEqual([]));
  await device.alerts.sync();
  expect(device.filed.size).toBe(0);
  expect(device.alerts.senderKey()).toBeNull();
  await stand.push.alert(RILEY, { kind: "finished", threadId: "cloud-thread", title: "t", body: "b" });
  expect(stand.push.pushed).toEqual([]);
});
