import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OrganizationSeatReply, SeatQuantityRequest } from "@openorc/protocol";
import { createHosted, type Hosted, type HostedDeps } from "./index.js";
import { hostDeps, newDevice, signInAs, testBrowser } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const ADMIN = "alex@example.com";
const MEMBER = "mira@example.com";
let stand: StandIn;
let now: number;
let spaceId: string;
const hosts: Hosted[] = [];
const period = { startsAt: "2026-11-01T00:00:00.000Z", endsAt: "2026-12-01T00:00:00.000Z" };
const holder = () => ({ kind: "member" as const, memberId: stand.spaces.member(spaceId, MEMBER)!.id, person: { id: "user-mira", name: "Mira", email: MEMBER, image: null }, paysForPro: false });
function seats(count = 3, standing: "live" | "ending" | "grace" = "live") {
  stand.seats.enabled = true;
  stand.seats.seed(spaceId, {
    subscription: {
      id: "subscription",
      plan: "monthly",
      standing,
      paidUntil: period.endsAt,
      graceUntil: null,
      quantity: count,
      overallocated: false,
      pendingQuantity: standing === "ending" ? { quantity: 0, at: period.endsAt } : null,
    },
    seats: Array.from({ length: count }, (_, index) => ({
      id: `seat-${index}`,
      assignment: index === 0 ? holder() : { kind: "available" as const },
      period,
      included: { grantedSeconds: 360_000, usedSeconds: 0, leftSeconds: 360_000 },
      retiresAt: null,
    })),
    available: count - 1,
  });
}
beforeEach(async () => {
  now = Date.parse("2026-11-16T00:00:00.000Z");
  stand = await standIn({ signup: "open", now: () => now });
  spaceId = stand.addTeam("Birch Studio", [ADMIN, MEMBER]);
});
afterEach(async () => {
  hosts.splice(0).forEach((host) => host.close());
  await stand.close();
});
async function admin(overrides: Partial<HostedDeps> = {}, device = newDevice()) {
  const browser = testBrowser(stand);
  const { deps } = hostDeps(stand, device, { browser, now: () => now, ...overrides });
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, ADMIN);
  await vi.waitFor(() => expect(hosted.spaces.status().state).toBe("ready"));
  return { hosted, device };
}
function value<T>(reply: OrganizationSeatReply<T>): T {
  if (reply.state !== "ready") throw new Error(reply.message);
  return reply.value;
}
const billing = () => stand.seats.records.get(spaceId)!;
const review = async (hosted: Hosted, count: number) => value(await hosted.organizationBilling.seats.previewQuantity(spaceId, count));
const request = async (hosted: Hosted, count: number): Promise<SeatQuantityRequest> => ({ seats: count, body: { id: randomUUID(), previewToken: (await review(hosted, count)).token } });
const confirm = async (hosted: Hosted, change: SeatQuantityRequest) => value(await hosted.organizationBilling.seats.setQuantity(spaceId, change));
const refusal = (work: Promise<unknown>) =>
  work.then(
    () => "",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

it("reviews more seats with the server's estimate, the part month of hours and its dates as times", async () => {
  seats();
  const { hosted } = await admin();
  expect(await review(hosted, 5)).toEqual({
    token: expect.any(String),
    expiresAt: now + 60_000,
    asOf: now,
    from: 3,
    to: 5,
    effect: "now",
    at: now,
    nextPrice: { amount: 10_000, currency: "usd" },
    estimatedChargeNow: { amount: 2000, currency: "usd" },
    firstGrantSecondsPerNewSeat: 180_000,
    firstGrantEndsAt: Date.parse(period.endsAt),
  });
});

it("adds seats once the change is complete, and then has nothing left to show", async () => {
  seats();
  const { hosted } = await admin();
  const work = await confirm(hosted, await request(hosted, 5));
  expect(work).toMatchObject({ request: { seats: 5 }, operation: { kind: "quantity", state: "complete" }, error: null });
  const read = await hosted.organizationBilling.get(spaceId);
  expect(read.billing).toMatchObject({ subscription: { quantity: 5 }, available: 4 });
  expect(read.quantity).toBeUndefined();
});

it("schedules fewer seats for renewal, holding back free seats and unseating nobody", async () => {
  seats();
  const { hosted } = await admin();
  expect(await review(hosted, 2)).toMatchObject({ from: 3, to: 2, effect: "renewal", at: Date.parse(period.endsAt), estimatedChargeNow: null, firstGrantSecondsPerNewSeat: 0, firstGrantEndsAt: null });
  await confirm(hosted, await request(hosted, 2));
  const read = (await hosted.organizationBilling.get(spaceId)).billing!;
  expect(read.subscription).toMatchObject({ quantity: 3, pendingQuantity: { quantity: 2, at: Date.parse(period.endsAt) } });
  expect(read.seats.map((seat) => [seat.assignment.kind, seat.retiresAt])).toEqual([
    ["member", null],
    ["available", null],
    ["available", Date.parse(period.endsAt)],
  ]);
  expect(read.available).toBe(1);
});

it("ends the seats at the paid period's end for zero, and keeps them again for the current number", async () => {
  seats();
  const { hosted } = await admin();
  expect(await review(hosted, 0)).toMatchObject({ to: 0, effect: "renewal", nextPrice: { amount: 0, currency: "usd" } });
  await confirm(hosted, await request(hosted, 0));
  expect((await hosted.organizationBilling.get(spaceId)).billing?.subscription).toMatchObject({ standing: "ending", quantity: 3, pendingQuantity: { quantity: 0 } });
  expect(await review(hosted, 3)).toMatchObject({ from: 3, to: 3, effect: "now", estimatedChargeNow: null });
  await confirm(hosted, await request(hosted, 3));
  expect((await hosted.organizationBilling.get(spaceId)).billing?.subscription).toMatchObject({ standing: "live", pendingQuantity: null });
});

it.each([
  ["fewer seats than people hold", 3, "live", 0, "Take back seats or revoke their invitations before reducing the number of seats."],
  ["the number it already has", 3, "live", 3, "The seats have changed. Review the change again."],
  ["another number while the seats are ending", 3, "ending", 5, "These seats are ending. Set them back to 3 to keep them, then change the number."],
  ["seats whose payment lapsed", 3, "grace", 5, "The payment for these seats didn't go through. Update the payment method in billing and try again."],
] as const)("refuses a review of %s in the server's words", async (_name, count, standing, asked, words) => {
  seats(count, standing);
  if (asked === 0) for (const seat of billing().seats) seat.assignment = holder();
  const { hosted } = await admin();
  expect(await refusal(review(hosted, asked === 0 ? 2 : asked))).toBe(words);
});

it("keeps a refused payment with the change, changes nothing, and shows it until the next change", async () => {
  seats();
  stand.seats.quantity.refusePayment = true;
  const { hosted } = await admin();
  const failed = await confirm(hosted, await request(hosted, 5));
  expect(failed.operation).toMatchObject({ state: "failed", message: "The payment for these seats didn't go through. Update the payment method in billing and try again." });
  const read = await hosted.organizationBilling.get(spaceId);
  expect(read.billing?.subscription?.quantity).toBe(3);
  expect(read.quantity).toEqual([failed]);
  stand.seats.quantity.refusePayment = false;
  await confirm(hosted, await request(hosted, 4));
  expect((await hosted.organizationBilling.get(spaceId)).quantity).toBeUndefined();
});

it("reads a change the server is still settling until it is done, never sending it again", async () => {
  seats();
  stand.seats.quantity.pending = true;
  const { hosted } = await admin();
  const change = await request(hosted, 5);
  expect((await confirm(hosted, change)).operation).toMatchObject({ state: "pending", message: "Updating seats." });
  expect((await hosted.organizationBilling.get(spaceId)).quantity).toMatchObject([{ request: change, operation: { state: "pending" } }]);
  expect(await refusal(confirm(hosted, await request(hosted, 4)))).toBe("Updating seats.");
  stand.seats.quantity.settle(change.body.id);
  expect(value(await hosted.organizationBilling.seats.quantityOperation(spaceId, change.body.id))).toMatchObject({ operation: { state: "complete" }, error: null });
  expect(stand.requests.filter((each) => each.method === "PATCH" && each.path === "/organization/billing/quantity")).toHaveLength(1);
  expect((await hosted.organizationBilling.get(spaceId)).billing?.subscription?.quantity).toBe(5);
});

it("keeps the exact request through a lost reply and a restart, and learns the outcome by reading", async () => {
  seats();
  let lose = true;
  const device = newDevice();
  const first = await admin(
    {
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (lose && init?.method === "PATCH" && new URL(String(url)).pathname === "/organization/billing/quantity") throw new TypeError("The reply was lost.");
        return response;
      },
    },
    device,
  );
  const change = await request(first.hosted, 5);
  const unknown = await confirm(first.hosted, change);
  expect(unknown).toMatchObject({ request: change, operation: null, error: expect.any(String) });
  expect(JSON.parse(device.seatQuantity!)).toMatchObject([{ work: { request: change } }]);
  first.hosted.close();
  lose = false;
  const second = await admin({}, device);
  expect((await second.hosted.organizationBilling.get(spaceId)).quantity).toMatchObject([{ request: change, operation: null }]);
  expect(value(await second.hosted.organizationBilling.seats.quantityOperation(spaceId, change.body.id))).toMatchObject({ operation: { state: "complete" }, error: null });
  expect(stand.requests.filter((each) => each.method === "PATCH" && each.path === "/organization/billing/quantity")).toHaveLength(1);
  expect(billing().subscription?.quantity).toBe(5);
});

it("never sends a used id again with other details", async () => {
  seats();
  const { hosted } = await admin();
  const change = await request(hosted, 5);
  await confirm(hosted, change);
  expect(await refusal(confirm(hosted, { ...change, seats: 6 }))).toBe("That change was already sent with different details. Read the seats again.");
});

it("answers a member's review as denied, with the server's words", async () => {
  seats();
  const { hosted } = await admin();
  stand.spaces.member(spaceId, ADMIN)!.role = "member";
  stand.spaces.member(spaceId, MEMBER)!.role = "admin";
  await hosted.spaces.refresh();
  expect(await hosted.organizationBilling.seats.previewQuantity(spaceId, 5)).toEqual({ state: "denied", message: expect.any(String) });
});
