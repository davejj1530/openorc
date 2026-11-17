import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { hostDeps, newDevice, signInAs } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const SELF = "alex@example.com";
let stand: StandIn;
const hosts: Hosted[] = [];
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
});
afterEach(async () => {
  hosts.splice(0).forEach((host) => host.close());
  await stand.close();
});
async function host() {
  const device = newDevice();
  const { deps, browser } = hostDeps(stand, device);
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, SELF);
  return { hosted, device };
}

it("reads what a deletion would do, refuses a wrong address or code signed in, and once taken signs this app and every other out", async () => {
  const { hosted, device } = await host();
  const { hosted: other } = await host();
  expect(await hosted.account.deletion()).toEqual({ email: SELF, deleted: [], left: [], held: [], pro: null });
  await hosted.account.sendDeletionCode();
  const otp = stand.lastCode(SELF)!;
  expect(otp).toMatch(/^\d{6}$/);
  await expect(hosted.account.deleteAccount({ email: "someone@example.com", otp })).rejects.toThrow(`Type ${SELF} exactly to delete your account.`);
  expect(hosted.account.status()).toMatchObject({ state: "signed-in", email: SELF });

  await hosted.account.deleteAccount({ email: SELF, otp });
  expect(hosted.account.status()).toMatchObject({ state: "signed-out", ended: false });
  expect(device.stored).toBeNull();
  // Another app of theirs hears its session ended at its next word with the server.
  await other.account.offers().catch(() => undefined);
  await vi.waitFor(() => expect(other.account.status()).toMatchObject({ state: "signed-out", ended: true }));
});
