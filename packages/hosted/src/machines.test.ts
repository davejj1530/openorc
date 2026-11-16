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

const machine = (id: string, stop: { can: true } | { can: false; reason: string } = { can: true }) => ({
  id,
  serviceName: "Vercel",
  since: "2026-11-16T10:00:00.000Z",
  seconds: 840,
  threads: [{ id: `thread-${id}`, title: "Fix the login redirect", holds: ["resting" as const] }],
  stop,
});
const asked = () => stand.requests.filter((request) => request.path === "/hosted/machines").length;

describe("a person's machines", () => {
  it("reads a server from before machines as unavailable, and asks it once a session", async () => {
    const ada = await signedIn(ADA);
    expect(await ada.machines.read()).toEqual({ state: "unavailable" });
    expect(await ada.machines.read()).toEqual({ state: "unavailable" });
    expect(asked()).toBe(1);
  });

  it("lists the machines with their start as a time, stops one, and says why one can't stop", async () => {
    stand.machines.present = true;
    stand.machines.awake.set(ADA, [machine("m1"), machine("m2", { can: false, reason: "Someone else's work is running there." })]);
    const ada = await signedIn(ADA);
    const read = await ada.machines.read();
    expect(read).toMatchObject({ state: "ready", machines: [{ id: "m1", since: Date.parse("2026-11-16T10:00:00.000Z"), seconds: 840 }, { id: "m2" }] });
    expect(await ada.machines.stop("m1")).toMatchObject({ state: "ready", machines: [{ id: "m2" }] });
    await expect(ada.machines.stop("m2")).rejects.toThrow("Someone else's work is running there.");
    await expect(ada.machines.stop("gone")).rejects.toThrow("That machine isn't running for you.");
    expect(await ada.machines.read()).toMatchObject({ state: "ready" });
  });
});
