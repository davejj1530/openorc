import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { settings } from "@openorc/db";
import { decodePairingUrl, openPush, pushKeys, type PushEnvelope } from "@openorc/link";
import { nodeCrypto } from "@openorc/link/node";
import { PHONE_APP, PUSH_SENDER_TAG, type CorePush, type PushEnvironment, type RpcMethod, type RpcParams, type RpcResults } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";
import { FakeApns } from "./remote/push/fake-apns.js";
import { RemoteTestClient } from "./remote/test-client.js";
import type { ProtectedSecretStore } from "./services/extraction-credentials.js";

const machine = { name: () => "Studio", lanHosts: () => ["127.0.0.1"], tailnetHosts: async () => [] };
const keyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = keyPair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const keyId = "ABC123DEFG";
const pemBody = pem.split("\n")[1]!;

let dataDir: string, core: OpenOrc, apns: FakeApns, saved: string | null, rpcId: number;
const pushed: CorePush[] = [];
const phones: RemoteTestClient[] = [];
const pushSecrets: ProtectedSecretStore = {
  load: async () => saved,
  save: async (value) => {
    saved = value;
  },
};

/** A phone paired now, holding a registration for the given host. */
async function registeredPhone(environment: PushEnvironment): Promise<RemoteTestClient> {
  const { url } = await core.remote.beginPairing();
  const phone = await RemoteTestClient.pair(url);
  if (typeof phone === "string") throw new Error(phone);
  phones.push(phone);
  await phone.device("push.register", { registration: registrationIn(environment) });
  return phone;
}
const registrationIn = (environment: PushEnvironment) => ({ token: randomBytes(32).toString("hex"), environment, alerts: "all", sound: true }) as const;

/** Every push.sender a phone heard, once it has also heard the Mac's answer to its last registration. */
async function senderChanges(phone: RemoteTestClient): Promise<number> {
  await vi.waitFor(() => expect(phone.pushes.at(-1)).toEqual({ type: "invalidate", keys: ["remote"] }));
  return phone.pushes.filter((push) => push.type === "invalidate" && push.keys.includes(PUSH_SENDER_TAG)).length;
}

async function call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> {
  const reply = await core.handle({ type: "rpc", id: ++rpcId, method, params });
  if (reply.type === "rpc.error") throw new Error(reply.message);
  return reply.result as RpcResults[M];
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "openorc-push-rpc-"));
  apns = await FakeApns.start({ publicKey: keyPair.publicKey, keyId, teamId: PHONE_APP.teamId, topic: PHONE_APP.bundleId });
  let remoteKey: string | null = null;
  core = await OpenOrc.create({
    dataDir,
    ephemeral: true,
    transport: { push: (message) => pushed.push(message) },
    remoteSecrets: { load: async () => remoteKey, save: async (value) => void (remoteKey = value) },
    pushSecrets,
    remoteNetwork: { port: 0, machine, apns: { sandbox: apns.origin, production: apns.origin } },
  });
  await core.remote.attach((request) => core.handle(request));
  await core.remote.configure(true);
});
beforeEach(() => {
  rpcId = 0;
  pushed.splice(0);
});
afterAll(async () => {
  for (const phone of phones) phone.close();
  await core.close();
  await apns.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("the Apple push key", () => {
  it("is added from Apple's file, kept only in protected storage, and named in the status by its id alone", async () => {
    const status = await call("remote.push.setKey", { keyId, pem });
    expect(status.push).toEqual({ keyId, phones: 0, problem: null });
    expect(saved).toBe(pem);
    expect(pushed).toContainEqual({ type: "invalidate", keys: ["remote", "push.sender"] });
    const read = JSON.stringify(await call("remote.status", {}));
    expect(read).toContain(keyId);
    expect(read).not.toContain(pemBody);
    expect(settings.get(core.db, "remote.push")).toBe(JSON.stringify({ keyId }));
  });

  it("stays out of the RPC log", async () => {
    vi.stubEnv("OPENORC_RPC_LOG", "1");
    const logging = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await call("remote.push.setKey", { keyId, pem });
      const logged = JSON.stringify(logging.mock.calls);
      expect(logged).toContain("remote.push.setKey [private]");
      expect(logged).not.toContain("PRIVATE KEY");
    } finally {
      logging.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("refuses anything but a P-256 key or a 10-character key id, without repeating what it was given", async () => {
    await call("remote.push.setKey", { keyId, pem });
    const other = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    await expect(call("remote.push.setKey", { keyId: "OTHER12345", pem: other })).rejects.toThrow(/^This is not an Apple push key\.$/);
    await expect(call("remote.push.setKey", { keyId: "short", pem })).rejects.toThrow("This is not an Apple push key.");
    await expect(call("remote.push.setKey", { keyId, pem: "x".repeat(5000) })).rejects.toThrow("This is not an Apple push key.");
    expect((await call("remote.status", {})).push.keyId).toBe(keyId);
    expect(saved).toBe(pem);
  });

  it("is removed by saving an empty key, and the status forgets it", async () => {
    await call("remote.push.setKey", { keyId, pem });
    const status = await call("remote.push.removeKey", {});
    expect(status.push.keyId).toBeNull();
    expect(saved).toBe("");
    expect(await call("remote.push.test", {})).toEqual({ sent: 0, failed: 0, problem: null });
  });

  it("stays out of a phone's reach", async () => {
    const { url } = await core.remote.beginPairing();
    const phone = await RemoteTestClient.pair(url);
    if (typeof phone === "string") throw new Error(phone);
    phones.push(phone);
    for (const method of ["remote.push.setKey", "remote.push.removeKey", "remote.push.test"] as const) {
      await expect(phone.request(method, method === "remote.push.setKey" ? { keyId, pem } : {})).rejects.toThrow("This is not available from a phone.");
    }
  });
});

describe("Send a test", () => {
  it("reaches every phone with notifications on, says how many, and shows Apple's refusal until a send succeeds", async () => {
    await call("remote.push.setKey", { keyId, pem });
    expect(await call("remote.push.test", {})).toEqual({ sent: 0, failed: 0, problem: null });

    const { url } = await core.remote.beginPairing();
    const macKey = decodePairingUrl(url).macKey;
    const phone = await RemoteTestClient.pair(url, { name: "David's iPhone" });
    if (typeof phone === "string") throw new Error(phone);
    phones.push(phone);
    const token = randomBytes(32).toString("hex");
    expect(await phone.device("push.register", { registration: { token, environment: "sandbox", alerts: "needs-you", sound: false } })).toEqual({ sandbox: "ready", production: "ready" });

    const before = apns.requests.length;
    expect(await call("remote.push.test", {})).toEqual({ sent: 1, failed: 0, problem: null });
    const request = apns.requests[before]!;
    expect(request.token).toBe(token);
    const notice = openPush(nodeCrypto, pushKeys(nodeCrypto, phone.keys, macKey, "phone").seal, (JSON.parse(request.body) as { o: PushEnvelope }).o);
    expect(notice).toEqual({ id: expect.any(String), kind: "test", threadId: null, title: "OpenOrc", body: "Notifications from Studio reach this iPhone." });

    apns.reply({ status: 403, reason: "BadEnvironmentKeyIdInToken" });
    const badEnvironment = { reason: "BadEnvironmentKeyIdInToken", environment: "sandbox" };
    expect(await call("remote.push.test", {})).toEqual({ sent: 0, failed: 0, problem: badEnvironment });
    expect((await call("remote.status", {})).push).toEqual({ keyId, phones: 1, problem: badEnvironment });
    expect(await phone.device("push.register", { registration: { token, environment: "sandbox", alerts: "all", sound: true } })).toEqual({ sandbox: "refused", production: "ready" });
    apns.reply({ status: 403, reason: "InvalidProviderToken" });
    await call("remote.push.test", {});
    expect((await call("remote.status", {})).push.problem).toEqual({ reason: "InvalidProviderToken", environment: "sandbox" });

    // A new key starts with no refusal, and a send that works clears one.
    expect((await call("remote.push.setKey", { keyId, pem })).push.problem).toBeNull();
    apns.reply({ status: 403, reason: "Forbidden" });
    await call("remote.push.test", {});
    expect(await call("remote.push.test", {})).toEqual({ sent: 1, failed: 0, problem: null });
    expect((await call("remote.status", {})).push.problem).toBeNull();
    expect(apns.problems).toEqual([]);
  });

  it("drops Apple's connection when the key is replaced or removed, so none carries two keys, and tells phones", async () => {
    const { url } = await core.remote.beginPairing();
    const phone = await RemoteTestClient.pair(url);
    if (typeof phone === "string") throw new Error(phone);
    phones.push(phone);
    await call("remote.push.setKey", { keyId, pem });
    expect(await phone.device("push.register", { registration: { token: randomBytes(32).toString("hex"), environment: "sandbox", alerts: "all", sound: true } })).toEqual({
      sandbox: "ready",
      production: "ready",
    });
    expect((await call("remote.push.test", {})).failed).toBe(0);
    expect(apns.openSessions).toBe(1);
    const session = apns.requests.at(-1)!.session;
    phone.pushes.splice(0);

    await call("remote.push.setKey", { keyId, pem });
    await expect.poll(() => apns.openSessions).toBe(0);
    await vi.waitFor(() => expect(phone.pushes).toContainEqual({ type: "invalidate", keys: ["remote", "push.sender"] }));
    await call("remote.push.test", {});
    expect(apns.requests.at(-1)!.session).toBe(session + 1);

    await call("remote.push.removeKey", {});
    await expect.poll(() => apns.openSessions).toBe(0);
  });

  it("tells phones once when Apple starts refusing the key, not again while it keeps refusing, and once when it stops", async () => {
    await call("remote.push.setKey", { keyId, pem });
    for (const { id } of (await call("remote.status", {})).devices) core.remote.removeDevice(id);
    const phone = await registeredPhone("sandbox");
    phone.pushes.splice(0);

    apns.reply({ status: 403, reason: "InvalidProviderToken" }, { status: 403, reason: "InvalidProviderToken" });
    await call("remote.push.test", {});
    await call("remote.push.test", {});
    expect(await phone.device("push.register", { registration: registrationIn("sandbox") })).toEqual({ sandbox: "refused", production: "ready" });
    expect(await senderChanges(phone)).toBe(1);

    expect(await call("remote.push.test", {})).toMatchObject({ sent: 1, problem: null });
    expect(await phone.device("push.register", { registration: registrationIn("sandbox") })).toEqual({ sandbox: "ready", production: "ready" });
    expect(await senderChanges(phone)).toBe(2);
  });

  it("answers for each host, so a phone hears its own host's state and alerts that arrive are never called refused", async () => {
    await call("remote.push.setKey", { keyId, pem });
    for (const { id } of (await call("remote.status", {})).devices) core.remote.removeDevice(id);
    const xcodeBuild = await registeredPhone("sandbox");
    const storeBuild = await registeredPhone("production");
    xcodeBuild.pushes.splice(0);

    const refused = { reason: "BadEnvironmentKeyIdInToken", environment: "production" };
    for (let round = 0; round < 3; round++) {
      apns.reply({ status: 200 }, { status: 403, reason: "BadEnvironmentKeyIdInToken" });
      expect(await call("remote.push.test", {})).toEqual({ sent: 1, failed: 0, problem: refused });
    }
    expect((await call("remote.status", {})).push.problem).toEqual(refused);
    const states = { sandbox: "ready", production: "refused" };
    expect(await storeBuild.device("push.register", { registration: registrationIn("production") })).toEqual(states);
    expect(await xcodeBuild.device("push.register", { registration: registrationIn("sandbox") })).toEqual(states);
    expect(await senderChanges(xcodeBuild)).toBe(1);

    // A phone that has not asked iOS yet names no host, and still hears both, so a sandbox build is asked to allow alerts.
    const { url } = await core.remote.beginPairing();
    const fresh = await RemoteTestClient.pair(url);
    if (typeof fresh === "string") throw new Error(fresh);
    phones.push(fresh);
    expect(await fresh.device("push.register", { registration: null })).toEqual(states);
  });
});
