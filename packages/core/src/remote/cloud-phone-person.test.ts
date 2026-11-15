import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { CLOUD, cloudMac, ME, TODAY, type CloudMac } from "./test-fixtures/cloud-mac.js";

let at: CloudMac;
beforeAll(async () => {
  at = await cloudMac();
}, 30_000);
afterAll(() => at.close());

it("tells a phone that shares cloud threads who is signed in on its Mac: a name and a picture, nothing else of the account", async () => {
  const capable = await at.phone(CLOUD);
  const account = await at.window("account.status", {});
  if (account.state !== "signed-in") throw new Error("not signed in");
  const person = await capable.request("account.person", {});
  expect(person).toEqual({ name: account.name, image: account.image });
  expect(Object.keys(person as object).sort()).toEqual(["image", "name"]);
  expect(JSON.stringify(person)).not.toContain(ME);

  await expect((await at.phone(TODAY)).request("account.person", {})).rejects.toThrow("This is not available from a phone.");
  await expect((await at.phone(null)).request("account.person", {})).rejects.toThrow("This is not available from a phone.");

  await at.window("account.signOut", {});
  await vi.waitFor(async () => expect(await capable.request("account.person", {})).toBeNull(), { timeout: 5_000 });
});
