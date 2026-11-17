import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, signInVerifier, type Hosted } from "./index.js";
import { hostDeps, newDevice, signInAs, type Device } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

/*
 * A signed-in Mac grants the person's phone a session of its own: the phone holds the verifier, the Mac asks the server
 * for a code for its challenge, and the phone trades the code and the verifier for its own token.
 */
const SELF = "member@example.com";
const PHONE = "OpenOrc on iPhone";
const CANT_FINISH = "This sign-in can't be finished. Sign in again.";
const hosts: Hosted[] = [];
let stand: StandIn;
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
});
afterEach(async () => {
  hosts.splice(0).forEach((hosted) => hosted.close());
  await stand.close();
});
async function device(signedIn: boolean): Promise<{ hosted: Hosted; device: Device }> {
  const stored = newDevice();
  const { deps, browser } = hostDeps(stand, stored);
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  if (signedIn) await signInAs(hosted, browser, SELF);
  return { hosted, device: stored };
}
const tokenOf = (stored: Device) => (JSON.parse(stored.stored ?? "{}") as { token?: string }).token;

it("signs a phone in with a code its signed-in Mac was granted, as the same person on a session of its own", async () => {
  const mac = await device(true);
  const phone = await device(false);
  const { verifier, challenge } = await signInVerifier();
  const grant = await mac.hosted.account.grantSignIn({ challenge, device: PHONE });
  expect(grant.expiresInMs).toBeGreaterThan(0);
  await phone.hosted.account.signInWithGrant({ request: grant.request, code: grant.code, verifier });
  await vi.waitFor(() => expect(phone.hosted.account.status()).toMatchObject({ state: "signed-in", email: SELF }));
  expect(tokenOf(phone.device)).toBeTruthy();
  expect(tokenOf(phone.device)).not.toBe(tokenOf(mac.device));
  // The code is spent: a second device can't finish with it.
  const other = await device(false);
  await expect(other.hosted.account.signInWithGrant({ request: grant.request, code: grant.code, verifier })).rejects.toThrow(CANT_FINISH);
});

it("finishes a grant only with the verifier behind its challenge, and a wrong one ends it", async () => {
  const mac = await device(true);
  const phone = await device(false);
  const { verifier, challenge } = await signInVerifier();
  const grant = await mac.hosted.account.grantSignIn({ challenge, device: PHONE });
  const stranger = await signInVerifier();
  await expect(phone.hosted.account.signInWithGrant({ request: grant.request, code: grant.code, verifier: stranger.verifier })).rejects.toThrow(CANT_FINISH);
  await expect(phone.hosted.account.signInWithGrant({ request: grant.request, code: grant.code, verifier })).rejects.toThrow(CANT_FINISH);
  expect(phone.hosted.account.status().state).toBe("signed-out");
});

it("grants nothing to a device that isn't signed in, and only so many a person at a time", async () => {
  const signedOut = await device(false);
  const { challenge } = await signInVerifier();
  await expect(signedOut.hosted.account.grantSignIn({ challenge, device: PHONE })).rejects.toThrow();
  expect(stand.requests.filter((request) => request.path === "/app-sign-in/grant" && request.authorized)).toEqual([]);
  const mac = await device(true);
  for (let grant = 0; grant < 10; grant++) await mac.hosted.account.grantSignIn({ challenge, device: PHONE });
  await expect(mac.hosted.account.grantSignIn({ challenge, device: PHONE })).rejects.toThrow("That's a lot of tries from here. Wait a few minutes and try again.");
});

it("gives a grant up, unused, on a phone that is signed in already", async () => {
  const mac = await device(true);
  const phone = await device(true);
  const { verifier, challenge } = await signInVerifier();
  const grant = await mac.hosted.account.grantSignIn({ challenge, device: PHONE });
  const before = tokenOf(phone.device);
  await phone.hosted.account.signInWithGrant({ request: grant.request, code: grant.code, verifier });
  expect(tokenOf(phone.device)).toBe(before);
  const other = await device(false);
  await expect(other.hosted.account.signInWithGrant({ request: grant.request, code: grant.code, verifier })).rejects.toThrow(CANT_FINISH);
});
