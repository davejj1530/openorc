import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted, type HostedDeps } from "./index.js";
import { hostDeps, newDevice, signInAs, testBrowser } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const MEMBER = "mira@example.com";
const frozen = { state: "frozen", reason: "seat_removed", until: null, message: "Your seat was taken back, and your day of grace has ended." } as const;
let stand: StandIn;
let team: string;
const hosts: Hosted[] = [];
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  team = stand.addTeam("Birch Studio", ["alex@example.com", MEMBER]);
  stand.addProject("alex@example.com", { name: "Canvas", fullName: "example/canvas" }, team);
});
afterEach(async () => {
  hosts.splice(0).forEach((host) => host.close());
  await stand.close();
});
async function person(overrides: Partial<HostedDeps> = {}) {
  const device = newDevice();
  device.projects = [{ id: "local-canvas", remote: "https://github.com/example/canvas" }];
  const browser = testBrowser(stand);
  const { deps, seen } = hostDeps(stand, device, { browser, ...overrides });
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, MEMBER);
  await vi.waitFor(() => expect(hosted.spaces.status().state).toBe("ready"));
  return { hosted, seen };
}
const grace = (until: number) =>
  ({ state: "grace", reason: "seat_removed", until: new Date(until).toISOString(), message: "Your seat was taken back; you have one day to get Pro to keep using organizations." }) as const;
const keys = (projects: { key: string }[]) => projects.map((project) => project.key);
const personal = (hosted: Hosted) => {
  const status = hosted.spaces.status();
  if (status.state !== "ready") throw new Error("The spaces are not ready.");
  return status.personalSpaceId;
};

it("keeps a folder paired with an organization's project in that organization while the person has access", async () => {
  stand.setBilling(MEMBER, { pro: true, standing: "live", at: new Date(Date.now() + 86_400_000).toISOString(), monthlyLeftSeconds: 3600, packsLeftSeconds: 0 });
  const { hosted } = await person();
  expect(keys(await hosted.spaces.projects(team))).toEqual(["local-canvas"]);
  expect(keys(await hosted.spaces.projects(personal(hosted)))).toEqual([]);
});

it("lists a frozen person's paired folder in Personal and nothing in the organization", async () => {
  stand.setBilling(MEMBER, { pro: false, organizationAccess: frozen });
  const { hosted } = await person();
  expect(hosted.spaces.status()).toMatchObject({ organizationAccess: { state: "frozen" }, spaces: expect.arrayContaining([expect.objectContaining({ id: team })]) });
  expect(keys(await hosted.spaces.projects(team))).toEqual([]);
  expect(keys(await hosted.spaces.projects(personal(hosted)))).toEqual(["local-canvas"]);
});

it("closes the organization's projects at the grace deadline with no answer from the server", async () => {
  let now = Date.now();
  const until = now + 60_000;
  stand.setBilling(MEMBER, { pro: true, standing: "grace", at: new Date(until).toISOString(), monthlyLeftSeconds: 0, packsLeftSeconds: 0, organizationAccess: grace(until) });
  const { hosted } = await person({ now: () => now });
  expect(keys(await hosted.spaces.projects(team))).toEqual(["local-canvas"]);
  await stand.down();
  now = until;
  expect(keys(await hosted.spaces.projects(team))).toEqual([]);
  expect(keys(await hosted.spaces.projects(personal(hosted)))).toEqual(["local-canvas"]);
});

it("tells the windows when the grace deadline passes, with nothing heard from the server", async () => {
  const until = Date.now() + 900;
  stand.setBilling(MEMBER, { pro: true, standing: "grace", at: new Date(until).toISOString(), monthlyLeftSeconds: 0, packsLeftSeconds: 0, organizationAccess: grace(until) });
  const { hosted, seen } = await person();
  await vi.waitFor(async () => expect(keys(await hosted.spaces.projects(team))).toEqual(["local-canvas"]));
  seen.pushes.length = 0;
  const billingReads = () => stand.requests.filter((request) => request.method === "GET" && request.path === "/billing").length;
  const before = billingReads();
  await vi.waitFor(() => expect(seen.pushes).toContainEqual({ type: "invalidate", keys: ["spaces", "projects"] }), { timeout: 3000 });
  // The account and the threads close at the same moment, on the core's own word.
  await vi.waitFor(() => expect(billingReads()).toBeGreaterThan(before));
  expect(keys(await hosted.spaces.projects(team))).toEqual([]);
});

it("carries each organization's own words for why it is closed to the person, and none while it is open", async () => {
  stand.setBilling(MEMBER, { pro: false, organizationAccess: frozen });
  const { hosted } = await person();
  const closed = hosted.spaces.status();
  expect(closed.state === "ready" && closed.spaces.find((space) => space.id === team)).toMatchObject({ accessMessage: frozen.message });
  stand.setBilling(MEMBER, {
    pro: true,
    standing: "live",
    at: new Date(Date.now() + 86_400_000).toISOString(),
    monthlyLeftSeconds: 3600,
    packsLeftSeconds: 0,
    organizationAccess: { state: "active", reason: null, until: null, message: null },
  });
  await hosted.spaces.refresh();
  const open = hosted.spaces.status();
  expect(open.state === "ready" && open.spaces.find((space) => space.id === team)).toMatchObject({ accessMessage: null });
});

it("waits for a grace deadline weeks away, past the longest timer the clock keeps, instead of telling the windows at once", async () => {
  const until = Date.now() + 30 * 86_400_000;
  stand.setBilling(MEMBER, { pro: true, standing: "grace", at: new Date(until).toISOString(), monthlyLeftSeconds: 0, packsLeftSeconds: 0, organizationAccess: grace(until) });
  const overflows: string[] = [];
  const heard = (warning: Error) => void (warning.name === "TimeoutOverflowWarning" && overflows.push(warning.message));
  process.on("warning", heard);
  try {
    const { hosted } = await person();
    await vi.waitFor(async () => expect(keys(await hosted.spaces.projects(team))).toEqual(["local-canvas"]));
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    process.off("warning", heard);
  }
  expect(overflows).toEqual([]);
});
