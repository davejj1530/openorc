import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { hostDeps, newDevice, signInAs } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const email = "reader@example.com";
let stand: StandIn;
let hosted: Hosted;
let seen: ReturnType<typeof hostDeps>["seen"];
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  const made = hostDeps(stand, newDevice());
  const { deps, browser } = made;
  seen = made.seen;
  hosted = createHosted(deps);
  await hosted.start();
  await signInAs(hosted, browser, email);
});
afterEach(async () => {
  hosted.close();
  await stand.close();
});

it("reads the person's own agent sign-in readings on OpenOrc Cloud, with when each was read", async () => {
  stand.agentUsage.readings.set(email, [{ agent: "claude", readAt: "2026-11-18T10:00:00.000Z", reading: { status: "ok", usage: {}, plan: "Max" } }]);
  expect(await hosted.account.agentUsage()).toEqual([{ agent: "claude", readAt: Date.parse("2026-11-18T10:00:00.000Z"), reading: { status: "ok", usage: {}, plan: "Max" } }]);
});

it("reads none from a server that keeps no readings, and none while signed out", async () => {
  stand.agentUsage.served = false;
  expect(await hosted.account.agentUsage()).toEqual([]);
  await hosted.account.signOut();
  stand.agentUsage.served = true;
  expect(await hosted.account.agentUsage()).toEqual([]);
});

it("asks again once the server says it kept a new reading, as a turn's end there does", async () => {
  const before = seen.pushes.length;
  stand.tell(email, ["usage"]);
  await vi.waitFor(() => expect(seen.pushes.slice(before)).toContainEqual({ type: "invalidate", keys: ["provider-usage"] }));
});
