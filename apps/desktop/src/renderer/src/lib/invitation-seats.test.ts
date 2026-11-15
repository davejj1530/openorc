import type { OrganizationSeat } from "@openorc/protocol";
import { expect, it } from "vitest";
import { chooseInvitationSeats, freeSeatsWords } from "./invitation-seats";

const period = { startsAt: 1, endsAt: 2 };
const seat = (id: string, hours: number | null, assignment: OrganizationSeat["assignment"] = { kind: "available" }, retiresAt: number | null = null): OrganizationSeat => ({
  id,
  assignment,
  period: hours === null ? null : period,
  included: hours === null ? null : { grantedSeconds: 360_000, usedSeconds: 360_000 - hours * 3600, leftSeconds: hours * 3600 },
  retiresAt,
});
const inventory = [seat("b", 40), seat("c", 100), seat("a", 40), seat("d", null)];
const choose = (addresses: string[], on: string[], seats = inventory, kept: Record<string, string> = {}) => chooseInvitationSeats({ addresses, wants: (email) => on.includes(email), seats, kept });

it("gives the fullest free seat first, then by seat id, and a seat of unknown hours last", () => {
  expect(choose(["one", "two", "three", "four"], ["one", "two", "three", "four"])).toEqual({ seats: { one: "c", two: "a", three: "b", four: "d" }, free: 4 });
});

it("gives a seat only to the addresses switched on", () => {
  expect(choose(["one", "two", "three"], ["three"])).toEqual({ seats: { three: "c" }, free: 4 });
});

it("keeps the seat an address already had while that seat is still free", () => {
  expect(choose(["one", "two"], ["one", "two"], inventory, { two: "c" })).toEqual({ seats: { two: "c", one: "a" }, free: 4 });
});

it("picks again for an address whose seat is no longer free, and never one seat for two addresses", () => {
  const taken = [seat("c", 100, { kind: "invitation", invitationId: "i", email: "x@example.com", expiresAt: 9 }), seat("a", 40), seat("b", 12)];
  expect(choose(["one", "two"], ["one", "two"], taken, { one: "c", two: "a" })).toEqual({ seats: { two: "a", one: "b" }, free: 2 });
  expect(choose(["one", "two"], ["one", "two"], taken, { one: "a", two: "a" })).toEqual({ seats: { one: "a", two: "b" }, free: 2 });
});

it("never counts or gives a held, reserved or ending seat", () => {
  const member = { kind: "member" as const, memberId: "m", person: { id: "u", name: "Mira", email: "mira@example.com", image: null }, paysForPro: false };
  expect(choose(["one", "two"], ["one", "two"], [seat("a", 100, member), seat("b", 90, { kind: "available" }, 5), seat("c", 10)])).toEqual({ seats: { one: "c" }, free: 1 });
});

it("gives nothing beyond the free seats, in the order the addresses were written", () => {
  expect(choose(["one", "two", "three"], ["one", "two", "three"], [seat("a", 10), seat("b", 20)])).toEqual({ seats: { one: "b", two: "a" }, free: 2 });
});

it("says how many of the free seats the draft takes", () => {
  expect(freeSeatsWords(1, 3)).toBe("1 of 3 free seats");
  expect(freeSeatsWords(0, 3)).toBe("0 of 3 free seats");
  expect(freeSeatsWords(2, 2)).toBe("2 of 2 free seats");
  expect(freeSeatsWords(0, 0)).toBe("0 free seats");
});
