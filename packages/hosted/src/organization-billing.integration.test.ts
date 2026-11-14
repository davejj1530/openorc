import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted, type HostedDeps } from "./index.js";
import { hostDeps, newDevice, signInAs, type Device } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

let stand: StandIn;
const hosts: Hosted[] = [];
const target = { page: "checkout", plan: "monthly", seats: 3 } as const;
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  stand.seats.enabled = true;
});
afterEach(async () => {
  hosts.splice(0).forEach((host) => host.close());
  await stand.close();
});
async function host(email = "admin@example.com", device: Device = newDevice(), overrides: Partial<HostedDeps> = {}) {
  const { deps, browser } = hostDeps(stand, device, overrides);
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  if (!device.stored) await signInAs(hosted, browser, email);
  await hosted.spaces.refresh();
  await vi.waitFor(() => expect(hosted.spaces.status().state).toBe("ready"));
  return { hosted, browser, device };
}

it("shares checkout between two admins and discovers quiet payment as available capacity", async () => {
  const team = stand.addTeam("Example team", ["admin@example.com", "second@example.com"]);
  stand.spaces.member(team, "second@example.com")!.role = "admin";
  const a = await host(),
    b = await host("second@example.com");
  await a.hosted.organizationBilling.get(team);
  await a.hosted.organizationBilling.open(team, target);
  await b.hosted.organizationBilling.open(team, target);
  expect(stand.seats.checkouts).toHaveLength(1);
  expect(a.browser.opened.at(-1)).toBe(b.browser.opened.at(-1));
  expect((await a.hosted.organizationBilling.get(team)).billing?.available).toBe(0);
  a.hosted.organizationBilling.leave(team);
  stand.seats.pay(team, { quiet: true });
  const done = await a.hosted.organizationBilling.get(team);
  expect(done).toMatchObject({ billing: { available: 3, subscription: { quantity: 3 } }, payment: { state: "complete", watching: false } });
  expect(done.billing?.seats.every((seat) => seat.assignment.kind === "available")).toBe(true);
  expect(stand.seats.checkouts).toHaveLength(1);
});

it("stores the exact request before sending and recovers its lost response after relaunch", async () => {
  const team = stand.addTeam("Example team", ["admin@example.com"]);
  const device = newDevice();
  let lose = true;
  const request: typeof fetch = async (input, init) => {
    const checkout = new URL(String(input)).pathname === "/organization/billing/checkout";
    if (checkout) expect(device.organizationBilling).toContain('"seats":3');
    const response = await fetch(input, init);
    if (checkout && lose) {
      lose = false;
      throw new TypeError("Response lost");
    }
    return response;
  };
  const a = await host("admin@example.com", device, { fetch: request });
  const pending = await a.hosted.organizationBilling.open(team, target);
  expect(pending.payment?.state).toBe("pending");
  const id = pending.payment?.id;
  a.hosted.close();
  const b = await host("admin@example.com", device, { fetch: request });
  const recovered = await b.hosted.organizationBilling.open(team, { page: "checkout", plan: "yearly", seats: 9 });
  expect(recovered.payment).toMatchObject({ id, target, state: "waiting" });
  expect(stand.seats.checkouts).toHaveLength(1);
  expect(stand.seats.checkouts[0]).toMatchObject({ plan: "monthly", seats: 3 });
});

it("keeps admin inventory private and changes only the explicit organization's checkout", async () => {
  const a = stand.addTeam("Example team", ["admin@example.com", "member@example.com"]);
  const b = stand.addTeam("Other team", ["admin@example.com"]);
  const admin = await host(),
    member = await host("member@example.com");
  await expect(member.hosted.organizationBilling.get(a)).rejects.toThrow("Only an admin");
  await admin.hosted.organizationBilling.open(a, target);
  await admin.hosted.organizationBilling.open(b, { ...target, seats: 2 });
  admin.hosted.organizationBilling.leave(a);
  await admin.hosted.organizationBilling.open(a, { ...target, plan: "yearly", seats: 4 });
  expect(stand.seats.checkouts.map((checkout) => [checkout.spaceId, checkout.plan, checkout.seats])).toEqual([
    [a, "yearly", 4],
    [b, "monthly", 2],
  ]);
});
