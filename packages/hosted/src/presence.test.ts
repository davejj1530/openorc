import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted, type HostedDeps } from "./index.js";
import { hostDeps, newDevice, signInAs } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

/*
 * Before it alerts the person's phone, OpenOrc Cloud asks their own computers whether someone is at one of them, as the
 * Mac's own alerts hold back: a computer answers with its reading, and one with none answers at once that nobody is.
 */
const SELF = "member@example.com";
const OTHER = "other@example.com";
const hosts: Hosted[] = [];
let stand: StandIn;
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
});
afterEach(async () => {
  hosts.splice(0).forEach((hosted) => hosted.close());
  await stand.close();
});
async function computer(email: string, inUse?: HostedDeps["inUse"]): Promise<Hosted> {
  const { deps, browser } = hostDeps(stand, newDevice(), inUse ? { inUse } : {});
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, email);
  await vi.waitFor(() => expect(hosted.account.status()).toMatchObject({ state: "signed-in", reach: "live" }));
  return hosted;
}

it("answers the server's ask with whether someone is at this computer, read each time it asks", async () => {
  let active = true;
  await computer(SELF, async () => active);
  expect(await stand.presence(SELF)).toBe(true);
  active = false;
  expect(await stand.presence(SELF)).toBe(false);
});

it("is in use when one of the person's computers is, and a computer with no reading answers at once that nobody is", async () => {
  await computer(SELF);
  const started = Date.now();
  expect(await stand.presence(SELF, 5_000)).toBe(false);
  expect(Date.now() - started).toBeLessThan(1_000);
  await computer(SELF, async () => true);
  expect(await stand.presence(SELF)).toBe(true);
});

it("answers only for its own person, and a reading that fails reads as away", async () => {
  await computer(OTHER, async () => true);
  expect(await stand.presence(SELF)).toBe(false);
  expect(await stand.presence(OTHER)).toBe(true);
  await computer(SELF, async () => {
    throw new Error("No reading");
  });
  expect(await stand.presence(SELF)).toBe(false);
});
