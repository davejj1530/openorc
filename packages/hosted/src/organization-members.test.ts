import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { hostDeps, newDevice, signInAs, testBrowser } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const ADMIN = "alex@example.com";
const MEMBER = "mira@example.com";
let stand: StandIn;
const hosts: Hosted[] = [];
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
});
afterEach(async () => {
  hosts.splice(0).forEach((host) => host.close());
  await stand.close();
});
async function person(email: string) {
  const browser = testBrowser(stand);
  const { deps, seen } = hostDeps(stand, newDevice(), { browser });
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, email);
  await vi.waitFor(() => expect(hosted.spaces.status().state).toBe("ready"));
  return { hosted, seen };
}

it("gives members and admins the same plan facts but refuses member writes and foreign targets", async () => {
  const spaceId = stand.addTeam("Birch Studio", [ADMIN, MEMBER]);
  const other = stand.addTeam("Cedar Studio", [ADMIN]);
  stand.setBilling(MEMBER, { pro: true, standing: "live", at: new Date(Date.now() + 86400000).toISOString(), monthlyLeftSeconds: 3600, packsLeftSeconds: 0 });
  const admin = await person(ADMIN);
  const member = await person(MEMBER);
  const roster = await admin.hosted.spaces.people(spaceId);
  const mine = stand.spaces.member(spaceId, MEMBER)!;
  expect((await member.hosted.spaces.people(spaceId)).members).toEqual(roster.members);
  expect(roster.members.find((row) => row.email === MEMBER)?.plan).toBe("pro");
  await expect(member.hosted.spaces.membership.setRole({ spaceId, memberId: mine.id, role: "admin" })).rejects.toThrow("Only an admin can do that.");
  await expect(member.hosted.spaces.membership.remove({ spaceId, memberId: mine.id })).rejects.toThrow("Only an admin can do that.");
  await expect(member.hosted.spaces.membership.delete({ spaceId, name: "Birch Studio" })).rejects.toThrow("Only an admin can do that.");
  await expect(admin.hosted.spaces.membership.remove({ spaceId: other, memberId: mine.id })).rejects.toThrow("That person isn't in this organization.");
});

it("preserves one admin when two people try to step down together, and refreshes their authority", async () => {
  const spaceId = stand.addTeam("Birch Studio", [ADMIN, MEMBER]);
  const admin = await person(ADMIN);
  const member = await person(MEMBER);
  const a = stand.spaces.member(spaceId, ADMIN)!;
  const b = stand.spaces.member(spaceId, MEMBER)!;
  await expect(admin.hosted.spaces.membership.leave({ spaceId })).rejects.toThrow("You're the only admin. Make someone else an admin first, or delete the organization.");
  await expect(admin.hosted.spaces.membership.setRole({ spaceId, memberId: a.id, role: "member" })).rejects.toThrow("Keep at least one admin in the organization.");
  const changed = await admin.hosted.spaces.membership.setRole({ spaceId, memberId: b.id, role: "admin" });
  expect(changed).toMatchObject({ memberId: b.id, spaceId, role: "admin", joinedAt: expect.any(Number) });
  const results = await Promise.allSettled([
    admin.hosted.spaces.membership.setRole({ spaceId, memberId: a.id, role: "member" }),
    member.hosted.spaces.membership.setRole({ spaceId, memberId: b.id, role: "member" }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const refusal = results.find((result) => result.status === "rejected");
  expect(refusal?.status === "rejected" && refusal.reason.message).toBe("Keep at least one admin in the organization.");
  expect((await admin.hosted.spaces.people(spaceId)).adminCount).toBe(1);
  const snapshot = admin.hosted.spaces.status();
  expect(snapshot.state === "ready" && snapshot.spaces.find((space) => space.id === spaceId)).toMatchObject({ role: a.role });
  expect(admin.seen.pushes).toContainEqual({ type: "invalidate", keys: expect.arrayContaining([`people:${spaceId}`]) });
});

it("removes and leaves by membership ID, reading empty 204 bodies and notifying both people", async () => {
  const spaceId = stand.addTeam("Birch Studio", [ADMIN, MEMBER, "jules@example.com"]);
  const admin = await person(ADMIN);
  const member = await person(MEMBER);
  const target = stand.spaces.member(spaceId, "jules@example.com")!;
  expect(await admin.hosted.spaces.membership.remove({ spaceId, memberId: target.id })).toEqual({});
  await expect(admin.hosted.spaces.membership.remove({ spaceId, memberId: target.id })).rejects.toThrow("That person isn't in this organization.");
  expect((await member.hosted.spaces.people(spaceId)).total).toBe(2);
  expect(await member.hosted.spaces.membership.leave({ spaceId })).toEqual({});
  const snapshot = member.hosted.spaces.status();
  expect(snapshot.state === "ready" && snapshot.spaces.some((space) => space.id === spaceId)).toBe(false);
  expect((await admin.hosted.spaces.people(spaceId)).total).toBe(1);
});

it("deletes only the confirmed organization and keeps the lifetime creation count", async () => {
  const admin = await person(ADMIN);
  const { spaceId } = await admin.hosted.spaces.setup.create({ name: "Birch Studio" });
  const other = stand.addTeam("Cedar Studio", [ADMIN]);
  stand.addProject(ADMIN, { name: "Canvas", fullName: "example/canvas" }, spaceId);
  await expect(admin.hosted.spaces.membership.delete({ spaceId, name: "Cedar Studio" })).rejects.toThrow("Type Birch Studio exactly to delete it.");
  expect(await admin.hosted.spaces.membership.delete({ spaceId, name: " Birch Studio " })).toEqual({});
  expect(stand.spaces.projectsIn(spaceId)).toEqual([]);
  expect(stand.spaces.teams.get(other)?.name).toBe("Cedar Studio");
  expect(stand.organizations.created.get(ADMIN)).toBe(1);
  await expect(admin.hosted.spaces.membership.leave({ spaceId: `personal-${ADMIN}` })).rejects.toThrow("Your personal space is yours alone, so it can't be left.");
  await expect(admin.hosted.spaces.membership.delete({ spaceId: `personal-${ADMIN}`, name: "Personal" })).rejects.toThrow(
    "Your personal space goes with your account, so it can't be deleted on its own.",
  );
});

it("answers a deletion the organization's billing refuses with the server's words and the day as a value, and keeps the organization", async () => {
  const spaceId = stand.addTeam("Birch Studio", [ADMIN]);
  const paidUntil = "2026-12-01T06:05:00.000Z";
  stand.seats.enabled = true;
  stand.seats.seed(spaceId, {
    subscription: { id: "subscription", plan: "monthly", standing: "live", paidUntil, graceUntil: null, quantity: 1, overallocated: false, pendingQuantity: null },
    seats: [],
    available: 0,
  });
  const admin = await person(ADMIN);
  expect(await admin.hosted.spaces.membership.delete({ spaceId, name: "Birch Studio" })).toEqual({
    refusal: { message: "This organization still pays for seats. Cancel the seats in billing; they will end on 2026-12-01.", endsAt: Date.parse(paidUntil) },
  });
  stand.seats.unsettled.add(spaceId);
  expect(await admin.hosted.spaces.membership.delete({ spaceId, name: "Birch Studio" })).toEqual({
    refusal: { message: "This organization's billing is still being updated. Wait for it to finish before deleting the organization.", endsAt: null },
  });
  expect(stand.spaces.teams.has(spaceId)).toBe(true);
});
