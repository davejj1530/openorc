import { generateKeyPairSync, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PHONE_APP, type PushEnvironment } from "@openorc/protocol";
import { ApnsRoute, apnsSigningKey } from "./apns.js";
import { FakeApns } from "./fake-apns.js";
import type { PushDelivery } from "./route.js";

const MINUTE = 60_000;
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const key = { keyId: "ABC123DEFG", teamId: PHONE_APP.teamId, pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString() };
const expected = { publicKey, keyId: key.keyId, teamId: key.teamId, topic: PHONE_APP.bundleId };

let clock: number;
let fakes: FakeApns[];
let routes: ApnsRoute[];

beforeEach(() => {
  clock = Date.UTC(2026, 9, 24, 12);
  fakes = [];
  routes = [];
});
afterEach(async () => {
  for (const route of routes) route.close();
  await Promise.all(fakes.map((fake) => fake.close()));
});

async function fake(): Promise<FakeApns> {
  const started = await FakeApns.start(expected);
  fakes.push(started);
  return started;
}

function routeTo(origins: Record<PushEnvironment, string>, answerWithinMs?: number): ApnsRoute {
  const route = new ApnsRoute({ key, topic: PHONE_APP.bundleId, origins, now: () => clock, ...(answerWithinMs ? { answerWithinMs } : {}) });
  routes.push(route);
  return route;
}

async function setup(answerWithinMs?: number) {
  const apns = await fake();
  return { apns, route: routeTo({ sandbox: apns.origin, production: apns.origin }, answerWithinMs) };
}

function delivery(patch: Partial<PushDelivery> = {}): PushDelivery {
  const payload = JSON.stringify({ aps: { alert: { body: "New activity on your Mac" }, "mutable-content": 1, sound: "default" }, o: { v: 1, m: "m", n: "n", c: "c" } });
  return { token: randomBytes(32).toString("hex"), environment: "sandbox", collapseId: "owCdjC9Y1AkDw9T-9DL2JQ", priority: 10, expiresAt: clock / 1000 + 12 * 3600, payload, ...patch };
}

describe("the APNs route", () => {
  it("posts an alert the way Apple asks, signed with the key's ES256 provider token", async () => {
    const { apns, route } = await setup();
    const sent = delivery();
    expect(await route.send(sent)).toEqual({ kind: "sent" });
    const quiet = delivery({ priority: 5, payload: JSON.stringify({ aps: { alert: { body: "New activity on your Mac" }, "mutable-content": 1, "interruption-level": "passive" } }) });
    expect(await route.send(quiet)).toEqual({ kind: "sent" });

    expect(apns.problems).toEqual([]);
    const [first, second] = apns.requests;
    expect(first).toMatchObject({ token: sent.token, body: sent.payload, jwt: { header: { alg: "ES256", kid: key.keyId }, claims: { iss: key.teamId, iat: clock / 1000 } } });
    expect(first!.headers).toMatchObject({
      "apns-topic": PHONE_APP.bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-collapse-id": sent.collapseId,
      "apns-expiration": String(sent.expiresAt),
    });
    expect(second!.headers).toMatchObject({ "apns-priority": "5" });
  });

  it("keeps one provider token for 50 minutes and signs a new one after", async () => {
    const { apns, route } = await setup();
    await route.send(delivery());
    clock += 49 * MINUTE;
    await route.send(delivery());
    clock += MINUTE;
    await route.send(delivery());
    const [first, second, third] = apns.requests.map((request) => request.jwt);
    expect(second!.raw).toBe(first!.raw);
    expect(third!.raw).not.toBe(first!.raw);
    expect(third!.claims["iat"]).toBe(clock / 1000);
  });

  it("keeps a connection while it is in use, however long, and replaces one idle over 5 minutes", async () => {
    const { apns, route } = await setup();
    await route.send(delivery());
    for (const wait of [4, 4, 4, 5]) {
      clock += wait * MINUTE;
      await route.send(delivery());
    }
    clock += 5 * MINUTE + 1;
    await route.send(delivery());
    expect(apns.requests.map((request) => request.session)).toEqual([1, 1, 1, 1, 1, 2]);
    expect(apns.openSessions).toBe(1);
  });

  it("signs a new token for ExpiredProviderToken once, only when the token is 20 minutes old", async () => {
    const { apns, route } = await setup();
    apns.reply({ status: 403, reason: "ExpiredProviderToken" });
    expect(await route.send(delivery())).toEqual({ kind: "refused", reason: "ExpiredProviderToken" });
    expect(apns.requests).toHaveLength(1);

    clock += 20 * MINUTE;
    apns.reply({ status: 403, reason: "ExpiredProviderToken" });
    expect(await route.send(delivery())).toEqual({ kind: "sent" });
    const [, stale, fresh] = apns.requests;
    expect(fresh!.jwt.raw).not.toBe(stale!.jwt.raw);

    clock += 20 * MINUTE;
    apns.reply({ status: 403, reason: "ExpiredProviderToken" }, { status: 403, reason: "ExpiredProviderToken" });
    expect(await route.send(delivery())).toEqual({ kind: "refused", reason: "ExpiredProviderToken" });
    expect(apns.requests).toHaveLength(5);
  });

  it("sends again on a fresh connection after a dropped connection, once", async () => {
    const { apns, route } = await setup();
    apns.reply("drop");
    expect(await route.send(delivery())).toEqual({ kind: "sent" });
    expect(apns.requests.map((request) => request.session)).toEqual([1, 2]);

    apns.reply("drop", "drop");
    expect(await route.send(delivery())).toMatchObject({ kind: "failed" });
    expect(apns.requests).toHaveLength(4);
    expect(await route.send(delivery())).toEqual({ kind: "sent" });
  });

  it("sends again on a fresh connection when Apple sends a connection away without taking the request", async () => {
    const { apns, route } = await setup();
    await route.send(delivery());
    apns.reply("goaway");
    expect(await route.send(delivery())).toEqual({ kind: "sent" });
    expect(apns.requests.map((request) => request.session)).toEqual([1, 1, 2]);
  });

  it("lets a request Apple still answers finish on a connection it sent away, and sends nothing twice", async () => {
    const { apns, route } = await setup();
    apns.reply({ status: 200, goaway: "before" });
    expect(await route.send(delivery())).toEqual({ kind: "sent" });
    expect(apns.requests.map((request) => request.session)).toEqual([1]);
    // A connection sent away takes no new request; on one already in use, the same holds.
    expect(await route.send(delivery())).toEqual({ kind: "sent" });
    apns.reply({ status: 200, goaway: "before" });
    expect(await route.send(delivery())).toEqual({ kind: "sent" });
    expect(await route.send(delivery())).toEqual({ kind: "sent" });
    expect(apns.requests.map((request) => request.session)).toEqual([1, 2, 2, 3]);
  });

  it("keeps Apple's refusal when a GOAWAY follows it at once", async () => {
    const { apns, route } = await setup();
    apns.reply({ status: 403, reason: "InvalidProviderToken", goaway: "after" });
    expect(await route.send(delivery())).toEqual({ kind: "refused", reason: "InvalidProviderToken" });
    apns.reply({ status: 200, goaway: "after" });
    expect(await route.send(delivery())).toEqual({ kind: "sent" });
    expect(apns.requests).toHaveLength(2);
  });

  it("takes Apple's answer from its status when a GOAWAY with an error code ends the connection before the body", async () => {
    const { apns, route } = await setup();
    apns.reply({ status: 403, reason: "InvalidProviderToken", goaway: "error" });
    expect(await route.send(delivery())).toMatchObject({ kind: "refused" });
    apns.reply({ status: 200, goaway: "error" });
    expect(await route.send(delivery())).toEqual({ kind: "sent" });
    expect(await route.send(delivery())).toEqual({ kind: "sent" });
    expect(apns.requests.map((request) => request.session)).toEqual([1, 2, 3]);
  });

  it("sends nothing again when a connection closes on a request Apple may have taken", async () => {
    const { apns, route } = await setup();
    const taken = { kind: "failed", reason: "The connection to APNs closed before it answered." };
    apns.reply("taken");
    expect(await route.send(delivery())).toEqual(taken);
    expect(apns.requests).toHaveLength(1);
    expect(await route.send(delivery())).toEqual({ kind: "sent" });
    apns.reply("taken");
    expect(await route.send(delivery())).toEqual(taken);
    expect(await route.send(delivery())).toEqual({ kind: "sent" });
    expect(apns.requests.map((request) => request.session)).toEqual([1, 2, 2, 3]);
  });

  it("gives up on a silent APNs after its wait, having tried a fresh connection once", async () => {
    const { apns, route } = await setup(300);
    apns.reply("silence", "silence");
    const started = Date.now();
    expect(await route.send(delivery())).toEqual({ kind: "failed", reason: "APNs did not answer in time." });
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
    expect(apns.requests.map((request) => request.session)).toEqual([1, 2]);
  });

  it("fails alerts to an environment at once for 30 seconds after a fresh connection was silent too, then tries again", async () => {
    const [sandbox, production] = [await fake(), await fake()];
    const route = routeTo({ sandbox: sandbox.origin, production: production.origin }, 300);
    sandbox.reply("silence", "silence");
    expect(await route.send(delivery())).toEqual({ kind: "failed", reason: "APNs did not answer in time." });

    const started = Date.now();
    clock += 30_000 - 1;
    expect(await route.send(delivery())).toEqual({ kind: "failed", reason: "APNs did not answer in time." });
    expect(Date.now() - started).toBeLessThan(300);
    expect(sandbox.requests).toHaveLength(2);
    expect(await route.send(delivery({ environment: "production" }))).toEqual({ kind: "sent" });

    clock += 1;
    expect(await route.send(delivery())).toEqual({ kind: "sent" });
    expect(sandbox.requests).toHaveLength(3);
  });

  it("keeps an environment open when the fresh connection answers after one silence, as after the Mac wakes", async () => {
    const { apns, route } = await setup(300);
    apns.reply("silence");
    expect(await route.send(delivery())).toEqual({ kind: "sent" });
    expect(await route.send(delivery())).toEqual({ kind: "sent" });
    expect(apns.requests.map((request) => request.session)).toEqual([1, 2, 2]);
  });

  it("waits 10 seconds for an answer by default", async () => {
    const apns = await fake();
    apns.reply("silence", "silence");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const route = new ApnsRoute({ key, topic: PHONE_APP.bundleId, origins: { sandbox: apns.origin, production: apns.origin }, now: () => clock });
      routes.push(route);
      let outcome: unknown = null;
      void route.send(delivery()).then((settled) => (outcome = settled));
      const turns = async (count: number) => {
        for (let i = 0; i < count; i++) await new Promise((resolve) => setImmediate(resolve));
      };
      const arrived = async (count: number) => {
        while (apns.requests.length < count) await turns(1);
      };
      await arrived(1);
      await vi.advanceTimersByTimeAsync(9_999);
      await turns(50);
      expect(apns.requests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await arrived(2);
      await vi.advanceTimersByTimeAsync(9_999);
      await turns(50);
      expect(outcome).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      await turns(5);
      expect(outcome).toEqual({ kind: "failed", reason: "APNs did not answer in time." });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [400, "BadDeviceToken", "gone"],
    [400, "DeviceTokenNotForTopic", "gone"],
    [410, "Unregistered", "gone"],
    [410, "ExpiredToken", "gone"],
    [403, "InvalidProviderToken", "refused"],
    [403, "MissingProviderToken", "refused"],
    [403, "BadEnvironmentKeyIdInToken", "refused"],
    [403, "UnrelatedKeyIdInToken", "refused"],
    [403, "Forbidden", "refused"],
    [400, "TopicDisallowed", "refused"],
    [400, "BadTopic", "refused"],
    [429, "TooManyRequests", "failed"],
    [429, "TooManyProviderTokenUpdates", "failed"],
    [500, "InternalServerError", "failed"],
    [503, "ServiceUnavailable", "failed"],
    [400, "BadCollapseId", "failed"],
    [413, "PayloadTooLarge", "failed"],
  ] as const)("reads %i %s as %s", async (status, reason, kind) => {
    const { apns, route } = await setup();
    apns.reply({ status, reason });
    expect(await route.send(delivery())).toEqual({ kind, reason });
    expect(apns.requests).toHaveLength(1);
  });

  it("sends each environment to its own host", async () => {
    const [sandbox, production] = [await fake(), await fake()];
    const route = routeTo({ sandbox: sandbox.origin, production: production.origin });
    await route.send(delivery({ environment: "production" }));
    await route.send(delivery({ environment: "sandbox" }));
    await route.send(delivery({ environment: "production" }));
    expect([sandbox.requests.length, production.requests.length]).toEqual([1, 2]);
  });

  it("sends one request at a time", async () => {
    const { apns, route } = await setup();
    const outcomes = await Promise.all([1, 2, 3, 4].map(() => route.send(delivery())));
    expect(outcomes).toEqual(Array(4).fill({ kind: "sent" }));
    expect(apns.maxInFlight).toBe(1);
  });

  it("closes its connections when closed, and sends nothing after", async () => {
    const { apns, route } = await setup();
    await route.send(delivery());
    route.close();
    await expect.poll(() => apns.openSessions).toBe(0);
    expect(await route.send(delivery())).toEqual({ kind: "failed", reason: "This route is closed." });
    expect(apns.requests).toHaveLength(1);
  });
});

describe("an Apple push key", () => {
  it("reads a P-256 key and refuses anything else without repeating it", () => {
    expect(apnsSigningKey(key.pem).asymmetricKeyDetails).toEqual({ namedCurve: "prime256v1" });
    const others = [
      generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----",
    ];
    for (const pem of others) {
      expect(() => apnsSigningKey(pem)).toThrow("This is not an Apple push key.");
      try {
        apnsSigningKey(pem);
      } catch (error) {
        expect(String(error)).not.toContain("PRIVATE KEY");
      }
    }
  });
});
