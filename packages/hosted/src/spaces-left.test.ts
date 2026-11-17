import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { hostDeps, newDevice, signInAs } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";
import { userOf } from "./testing/stand-in-spaces.js";

const PERSON = "first@example.com";
let stand: StandIn;
const hosts: Hosted[] = [];
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
});
afterEach(async () => {
  hosts.splice(0).forEach((host) => host.close());
  await stand.close();
});

it("says which organization the account left, once, and nothing for the ones it keeps", async () => {
  const leaving = stand.addTeam("Birch Studio", [PERSON]);
  const staying = stand.addTeam("Cedar Studio", [PERSON]);
  const spaceLeft = vi.fn();
  const { deps, browser } = hostDeps(stand, newDevice(), { spaceLeft });
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, PERSON);
  await vi.waitFor(() => expect(hosted.spaces.status().state).toBe("ready"));
  stand.spaces.removeMember(leaving, PERSON);
  await hosted.spaces.refresh();
  expect(spaceLeft).toHaveBeenCalledTimes(1);
  expect(spaceLeft).toHaveBeenCalledWith({ apiOrigin: new URL(stand.url).origin, accountId: userOf(PERSON), spaceId: leaving });
  await hosted.spaces.refresh();
  expect(spaceLeft).toHaveBeenCalledTimes(1);
  expect(spaceLeft.mock.calls.some(([left]) => left.spaceId === staying)).toBe(false);
});
