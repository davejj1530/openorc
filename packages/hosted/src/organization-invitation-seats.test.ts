import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { hostDeps, newDevice, signInAs, testBrowser } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const ADMIN = "alex@example.com";
const GUEST = "tess@example.com";
let stand: StandIn;
let now: number;
let spaceId: string;
const hosts: Hosted[] = [];
const period = { startsAt: "2026-11-01T00:00:00.000Z", endsAt: "2026-12-01T00:00:00.000Z" };
const seat = (id: string, hours: number) => ({
  id,
  assignment: { kind: "available" as const },
  period,
  included: { grantedSeconds: 360_000, usedSeconds: 360_000 - hours * 3600, leftSeconds: hours * 3600 },
  retiresAt: null,
});
function seats(standing: "live" | "ending" | "grace" = "live") {
  stand.seats.enabled = true;
  stand.seats.seed(spaceId, {
    subscription: { id: "subscription", plan: "monthly", standing, paidUntil: period.endsAt, graceUntil: null, quantity: 2, overallocated: false, pendingQuantity: null },
    seats: [seat("seat-full", 100), seat("seat-used", 12)],
    available: 2,
  });
}
beforeEach(async () => {
  now = Date.parse("2026-11-10T00:00:00.000Z");
  stand = await standIn({ signup: "open", now: () => now });
  spaceId = stand.addTeam("Birch Studio", [ADMIN]);
});
afterEach(async () => {
  hosts.splice(0).forEach((host) => host.close());
  await stand.close();
});
async function person(email = ADMIN) {
  const browser = testBrowser(stand);
  const { deps } = hostDeps(stand, newDevice(), { browser, now: () => now });
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, email);
  await vi.waitFor(() => expect(hosted.spaces.status().state).toBe("ready"));
  return hosted;
}
const inventory = () => stand.seats.records.get(spaceId)!;
const held = (id: string) => inventory().seats.find((each) => each.id === id)!.assignment;
const invite = (hosted: Hosted, emails: string[], chosen?: Record<string, string>) => hosted.spaces.invitations.send({ spaceId, emails, role: "member", ...(chosen && { seats: chosen }) });

it("holds the named seat for an invitation and reads back that it includes Pro", async () => {
  seats();
  const hosted = await person();
  const [result] = await invite(hosted, [GUEST], { [GUEST]: "seat-full" });
  expect(result).toMatchObject({ email: GUEST, state: "sent", invitation: { includesSeat: true } });
  expect(held("seat-full")).toMatchObject({ kind: "invitation", email: GUEST });
  expect(inventory().available).toBe(1);
  expect((await hosted.spaces.invitations.list(spaceId)).map((row) => [row.email, row.includesSeat])).toEqual([[GUEST, true]]);
});

it("sends no seat for an address without one, and that invitation does not include Pro", async () => {
  seats();
  const hosted = await person();
  const results = await invite(hosted, [GUEST, "lee@example.com"], { [GUEST]: "seat-used" });
  expect(results.map((row) => [row.email, row.state === "sent" && row.invitation?.includesSeat])).toEqual([
    [GUEST, true],
    ["lee@example.com", false],
  ]);
  expect(inventory().available).toBe(1);
});

it("gives the server's words for a seat that was just taken, and creates no invitation", async () => {
  seats();
  const hosted = await person();
  await invite(hosted, ["lee@example.com"], { "lee@example.com": "seat-full" });
  const [result] = await invite(hosted, [GUEST], { [GUEST]: "seat-full" });
  expect(result).toEqual({ email: GUEST, state: "refused", error: "That seat was just taken. Send the invitation again." });
  expect((await hosted.spaces.invitations.list(spaceId)).map((row) => row.email)).toEqual(["lee@example.com"]);
});

it.each([
  ["a seat of no organization here", "missing", 404, "That seat isn't in this organization."],
  ["seats whose payment lapsed", "seat-full", 402, "The payment for these seats didn't go through. Update the payment method in billing and try again."],
])("refuses %s in the server's words", async (_name, seatId, _status, words) => {
  seats(seatId === "missing" ? "live" : "grace");
  const hosted = await person();
  expect(await invite(hosted, [GUEST], { [GUEST]: seatId })).toEqual([{ email: GUEST, state: "refused", error: words }]);
  expect(inventory().available).toBe(2);
});

it("says there are no seats when every one is taken", async () => {
  seats();
  const hosted = await person();
  await invite(hosted, ["a@example.com", "b@example.com"], { "a@example.com": "seat-full", "b@example.com": "seat-used" });
  expect(await invite(hosted, [GUEST], { [GUEST]: "seat-full" })).toEqual([{ email: GUEST, state: "refused", error: "There are no available seats. Buy another seat or take one back first." }]);
});

it("frees the seat when the invitation is revoked", async () => {
  seats();
  const hosted = await person();
  const [result] = await invite(hosted, [GUEST], { [GUEST]: "seat-full" });
  if (result?.state !== "sent") throw new Error("The invitation was not sent.");
  await hosted.spaces.invitations.revoke({ spaceId, invitationId: result.invitationId });
  expect(held("seat-full")).toEqual({ kind: "available" });
  expect(inventory().available).toBe(2);
});

it("stops counting a hold at the invitation's expiry, and takes the same seat again on resend", async () => {
  seats();
  const hosted = await person();
  const [result] = await invite(hosted, [GUEST], { [GUEST]: "seat-full" });
  if (result?.state !== "sent") throw new Error("The invitation was not sent.");
  now += 8 * 86_400_000;
  expect((await hosted.spaces.invitations.list(spaceId)).map((row) => [row.state, row.includesSeat])).toEqual([["expired", false]]);
  expect((await hosted.organizationBilling.get(spaceId)).billing?.available).toBe(2);
  const again = await hosted.spaces.invitations.resend({ spaceId, invitationId: result.invitationId });
  expect(again).toMatchObject({ state: "pending", includesSeat: true });
  expect(held("seat-full")).toMatchObject({ kind: "invitation", email: GUEST });
});

it("tells the invited person the invitation includes Pro, and gives them the seat when they join", async () => {
  seats();
  const admin = await person();
  await invite(admin, [GUEST], { [GUEST]: "seat-full" });
  await invite(admin, ["lee@example.com"]);
  const guest = await person(GUEST);
  const status = guest.spaces.status();
  if (status.state !== "ready") throw new Error("The spaces are not ready.");
  expect(status.invitations.map((row) => row.includesSeat)).toEqual([true]);
  await guest.spaces.received.accept(status.invitations[0]!.id);
  expect(held("seat-full")).toMatchObject({ kind: "member", memberId: stand.spaces.member(spaceId, GUEST)!.id });
  const plain = await person("lee@example.com");
  const other = plain.spaces.status();
  expect(other.state === "ready" && other.invitations.map((row) => row.includesSeat)).toEqual([false]);
});

it("reads a server from before seats as it always did, with nothing said about Pro", async () => {
  stand.organizations.invitations.seats = null;
  const hosted = await person();
  const [result] = await invite(hosted, [GUEST], { [GUEST]: "seat-full" });
  expect(result).toMatchObject({ state: "sent" });
  expect(result?.state === "sent" && result.invitation && "includesSeat" in result.invitation).toBe(false);
});
