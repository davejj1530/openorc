import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { hostDeps, newDevice, signInAs } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const ADA = "ada@example.com";
let stand: StandIn;
const hosts: Hosted[] = [];

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
});
afterEach(async () => {
  for (const hosted of hosts.splice(0)) hosted.close();
  await stand.close();
});

async function signedIn(email: string) {
  const { deps, browser } = hostDeps(stand, newDevice());
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, email);
  return hosted;
}
const asked = () => stand.requests.filter((request) => request.path === "/hosted/check").length;

describe("the cloud check", () => {
  it("reads a server from before the check as unavailable, and asks it once a session", async () => {
    const ada = await signedIn(ADA);
    expect(await ada.check.read()).toEqual({ state: "unavailable" });
    expect(await ada.check.read()).toEqual({ state: "unavailable" });
    expect(asked()).toBe(1);
  });

  it("starts one in the space named, reads it as it goes, and says a refused start in words", async () => {
    stand.check.present = true;
    const ada = await signedIn(ADA);
    expect(await ada.check.read()).toEqual({ state: "ready", check: null });
    const started = await ada.check.start("space-1");
    expect(started).toMatchObject({ state: "ready", check: { done: false, service: "Vercel", broken: null } });
    expect(stand.check.spaces).toEqual(["space-1"]);
    stand.check.finish(ADA, { codex: "ChatGPT ended this sign-in. Sign in with ChatGPT again." });
    const read = await ada.check.read();
    expect(read).toMatchObject({ state: "ready", check: { done: true, broken: "codex" } });
    if (read.state === "ready") expect(typeof read.check?.startedAt).toBe("number");
    stand.check.limit = 1;
    await expect(ada.check.start("space-1")).rejects.toThrow("That's a lot of checks at once.");
  });
});
