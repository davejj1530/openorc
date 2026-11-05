import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { remoteDevices, remotePushTargets } from "@openorc/db";
import { fromBase64Url, openPush, pushKeys, type PushEnvelope } from "@openorc/link";
import { nodeCrypto } from "@openorc/link/node";
import { PHONE_APP } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";
import { FakeApns } from "./remote/push/fake-apns.js";

const machine = { name: () => "Cloud", lanHosts: () => [], tailnetHosts: async () => [] };
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pushKey = { keyId: "ABC123DEFG", pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString() };

let apns: FakeApns;
let root: string;
let core: OpenOrc | null = null;

beforeAll(async () => {
  apns = await FakeApns.start({ publicKey, keyId: pushKey.keyId, teamId: PHONE_APP.teamId, topic: PHONE_APP.bundleId });
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-brain-alerts-"));
});
afterEach(async () => {
  await core?.close();
  core = null;
});
afterAll(async () => {
  await apns.close();
  await rm(root, { recursive: true, force: true });
});

/** A host with phone access on and the push key, as the brain has once the Mac handed it over, and one phone registered. */
async function host(publicAddress?: string) {
  let remoteKey: string | null = null;
  let saved: string | null = null;
  await core?.close();
  core = await OpenOrc.create({
    dataDir: await mkdtemp(path.join(root, "data-")),
    ephemeral: true,
    transport: { push: () => undefined },
    remoteSecrets: { load: async () => remoteKey, save: async (value) => void (remoteKey = value) },
    pushSecrets: { load: async () => saved, save: async (value) => void (saved = value) },
    remoteNetwork: { port: 0, machine, ...(publicAddress ? { publicAddress } : {}), apns: { sandbox: apns.origin, production: apns.origin } },
  });
  await core.remote.attach((request) => core!.handle(request));
  await core.remote.configure(true);
  await core.remote.setPushKey(pushKey.keyId, pushKey.pem);
  const hostKey = nodeCrypto.keyPairFromPrivate(fromBase64Url((JSON.parse(remoteKey!) as { privateKey: string }).privateKey)).publicKey;
  const phone = nodeCrypto.generateKeyPair();
  const device = remoteDevices.upsert(core.db, { publicKey: phone.publicKey, name: "iPhone", at: Date.now() });
  const token = randomBytes(32).toString("hex");
  remotePushTargets.set(core.db, device.id, { token, environment: "sandbox", alerts: "all", sound: true }, Date.now());
  return { core, hostKey, phone, token };
}

it("seals the cloud brain's alerts for each phone under its own key, with an outer text that names the cloud, not a Mac", async () => {
  for (const [address, outer] of [
    [undefined, "New activity on your Mac"],
    ["sb-brain.vercel.run", "New activity in the cloud"],
  ] as const) {
    const { core, hostKey, phone, token } = await host(address);
    const before = apns.requests.length;
    core.remote.alert({ type: "notify", id: `notice-${outer}`, kind: "finished", threadId: "thread-1", taskId: null, title: "Fix the login bug", body: "Done. The tests pass." });
    await vi.waitFor(() => expect(apns.requests.length).toBe(before + 1));
    const request = apns.requests.at(-1)!;
    expect([request.token, request.problems]).toEqual([token, []]);
    const sent = JSON.parse(request.body) as { aps: { alert: { body: string } }; o: PushEnvelope };
    expect(sent.aps.alert.body).toBe(outer);
    expect(request.body).not.toContain("login bug");
    expect(openPush(nodeCrypto, pushKeys(nodeCrypto, phone, hostKey, "phone").seal, sent.o)).toMatchObject({ title: "Fix the login bug", threadId: "thread-1" });
  }
});
