import { createHosted, signInVerifier, type Hosted } from "@openorc/hosted";
import { CLOUD_SESSION, CLOUD_SESSION_TAG } from "@openorc/protocol";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { liveSocket } from "../services/openorc-account.js";
import { NO_CLOUD_SESSION } from "./remote-access.js";
import { CLOUD, cloudMac, ME, TODAY, type CloudMac } from "./test-fixtures/cloud-mac.js";

/*
 * A Mac signed in to OpenOrc Cloud gets a phone that asks a session of its own, for the same person: a one-time code
 * bound to the phone's challenge, which only the phone, holding the verifier, can finish. The phone then reads the
 * cloud itself, and hears from the Mac when the person here signs out or changes.
 */

const PHONE = "OpenOrc on iPhone";
const FROM_PHONE = "This is not available from a phone.";
const WITH_SESSION = [...CLOUD, CLOUD_SESSION];

let at: CloudMac;
beforeAll(async () => {
  at = await cloudMac();
}, 30_000);
afterAll(() => at.close());

const phones: Hosted[] = [];
afterEach(() => phones.splice(0).forEach((hosted) => hosted.close()));

/** The phone's own OpenOrc Cloud, as it will mount the hosted package: its own session store, no browser. */
async function phoneCloud(server: string) {
  const store = { value: null as string | null };
  const hosted = createHosted({
    server,
    session: { load: async () => store.value, save: async (value) => void (store.value = value) },
    kept: { load: () => null, save: () => undefined },
    projects: () => [],
    fetch,
    connect: liveSocket,
    push: () => undefined,
    notify: () => undefined,
    deviceName: PHONE,
    now: () => Date.now(),
    log: { info: () => undefined, warn: () => undefined },
  });
  phones.push(hosted);
  await hosted.start();
  return { hosted, token: () => (JSON.parse(store.value ?? "{}") as { token?: string }).token };
}

const refusal = (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: Error) => error.message,
  );

it("gets a phone that asks a session of its own for the person signed in here, which only the phone can finish", async () => {
  const phone = await at.phone(WITH_SESSION);
  const owner = await phone.device("cloud.session.owner", {});
  expect(owner).toEqual({ server: at.stand.url, email: ME });
  const { verifier, challenge } = await signInVerifier();
  const grant = await phone.device("cloud.session.grant", { challenge, device: PHONE });
  expect(grant).toMatchObject({ server: at.stand.url, email: ME, request: expect.any(String), code: expect.any(String), expiresInMs: expect.any(Number) });
  const own = await phoneCloud(grant.server);
  await own.hosted.account.signInWithGrant({ request: grant.request, code: grant.code, verifier });
  await vi.waitFor(() => expect(own.hosted.account.status()).toMatchObject({ state: "signed-in", email: ME }));
  // Its own token, never the Mac's: the Mac's window is still signed in after the phone signs out.
  await own.hosted.account.signOut();
  expect(await at.window("account.status", {})).toMatchObject({ state: "signed-in", email: ME });
});

it("asks nothing of the account for a session that did not ask for it, nor for a challenge that is not one", async () => {
  const before = at.stand.requests.filter((request) => request.path === "/app-sign-in/grant").length;
  for (const capabilities of [null, TODAY, CLOUD]) {
    const phone = await at.phone(capabilities);
    expect(await refusal(phone.device("cloud.session.owner", {}))).toBe(FROM_PHONE);
    expect(await refusal(phone.device("cloud.session.grant", { challenge: "c".repeat(43), device: PHONE }))).toBe(FROM_PHONE);
  }
  const asking = await at.phone(WITH_SESSION);
  expect(await refusal(asking.device("cloud.session.grant", { challenge: "short", device: PHONE }))).toMatch(/challenge/);
  expect(await refusal(asking.device("cloud.session.grant", { challenge: "c".repeat(43), device: "x".repeat(81) }))).toMatch(/device/);
  expect(at.stand.requests.filter((request) => request.path === "/app-sign-in/grant").length).toBe(before);
});

it("tells a phone with a session of its own when the person here signs out, then has no one to give it, and no other phone hears", async () => {
  const phone = await at.phone(WITH_SESSION);
  const other = await at.phone(CLOUD);
  const heard = (client: typeof phone) => client.received.filter((message) => message.t === "push" && message.push.type === "invalidate" && message.push.keys.includes(CLOUD_SESSION_TAG));
  await at.window("account.signOut", {});
  await vi.waitFor(() => expect(heard(phone).length).toBeGreaterThan(0));
  expect(await phone.device("cloud.session.owner", {})).toBeNull();
  const { challenge } = await signInVerifier();
  expect(await refusal(phone.device("cloud.session.grant", { challenge, device: PHONE }))).toBe(NO_CLOUD_SESSION);
  expect(heard(other)).toEqual([]);
  await at.window("account.signIn", {});
  await vi.waitFor(async () => expect(await phone.device("cloud.session.owner", {})).toEqual({ server: at.stand.url, email: ME }), { timeout: 5_000 });
});
