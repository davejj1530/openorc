import { expect, it } from "vitest";
import { StandInSeats } from "./stand-in-seats.js";
import { StandInSpaces } from "./stand-in-spaces.js";

function fixture() {
  let now = Date.parse("2026-11-01T00:00:00.000Z");
  const spaces = new StandInSpaces();
  const spaceId = spaces.addTeam("Example team", ["admin@example.com", "second@example.com"]);
  const second = spaces.member(spaceId, "second@example.com");
  if (!second) throw new Error("Missing fixture member");
  second.role = "admin";
  const seats = new StandInSeats({ spaces, now: () => now, origin: () => "https://example.com", tell: () => {} });
  seats.enabled = true;
  const checkout = (count = 3, who = "admin@example.com") =>
    seats.route({ method: "POST", path: "/organization/billing/checkout", query: new URLSearchParams(), space: spaceId }, who, { plan: "monthly", seats: count });
  return {
    seats,
    spaceId,
    checkout,
    advance: () => {
      now += 2 * 86_400_000;
    },
  };
}

it("keeps one pending checkout across repeats, another admin and changed choices", () => {
  const f = fixture();
  const first = f.checkout();
  expect(f.checkout()).toEqual(first);
  expect(f.checkout(3, "second@example.com")).toEqual(first);
  expect(f.checkout(8)).toEqual(first);
  expect(f.seats.checkouts).toHaveLength(1);
  expect(f.seats.checkouts[0]?.seats).toBe(8);
});
it("does not replace a checkout merely because its local expiry passed", () => {
  const f = fixture();
  const first = f.checkout();
  f.advance();
  expect(f.checkout()).toEqual(first);
  expect(f.seats.checkouts).toHaveLength(1);
  f.seats.expire(f.spaceId);
  expect(f.checkout()).not.toEqual(first);
  expect(f.seats.checkouts).toHaveLength(2);
});
it("makes confirmed seats available without assigning the buyer and refuses another purchase", () => {
  const f = fixture();
  f.checkout();
  expect(f.seats.records.get(f.spaceId)?.available ?? 0).toBe(0);
  f.seats.pay(f.spaceId, { quiet: true });
  expect(f.seats.records.get(f.spaceId)?.available).toBe(3);
  expect(f.seats.records.get(f.spaceId)?.seats.every((seat) => seat.assignment.kind === "available")).toBe(true);
  expect(f.checkout()).toMatchObject({ status: 409, body: { message: "This organization already pays for seats. Change the number of seats in billing." } });
  expect(f.seats.checkouts).toHaveLength(1);
});

it("keeps retired slots when a confirmed ended subscription is replaced", () => {
  const f = fixture();
  f.checkout();
  f.seats.pay(f.spaceId, { quiet: true });
  const record = f.seats.records.get(f.spaceId)!;
  record.subscription!.standing = "ended";
  record.seats = record.seats.map((seat) => ({ ...seat, retiresAt: "2026-11-01T00:00:00.000Z" }));
  const previous = structuredClone(record.seats);
  expect(f.checkout(2)?.status).toBe(200);
  f.seats.pay(f.spaceId, { quiet: true });
  expect(f.seats.records.get(f.spaceId)?.seats.slice(0, previous.length)).toEqual(previous);
  expect(f.seats.records.get(f.spaceId)?.available).toBe(2);
});

it("refuses deleting an organization whose seats are paid, ending or still being settled, in the server's words", () => {
  const f = fixture();
  const remove = (who = "admin@example.com") => f.seats.route({ method: "DELETE", path: "/settings/organization", query: new URLSearchParams(), space: f.spaceId }, who, {});
  expect(remove()).toBeNull();
  const subscription = {
    id: "s",
    plan: "monthly" as const,
    standing: "live" as const,
    paidUntil: "2026-12-01T06:05:00.000Z",
    graceUntil: null,
    quantity: 2,
    overallocated: false,
    pendingQuantity: null,
  };
  f.seats.seed(f.spaceId, { subscription });
  expect(remove()).toEqual({
    status: 409,
    body: { statusCode: 409, message: "This organization still pays for seats. Cancel the seats in billing; they will end on 2026-12-01.", endsAt: "2026-12-01T06:05:00.000Z" },
  });
  f.seats.seed(f.spaceId, { subscription: { ...subscription, standing: "ending" } });
  expect(remove()?.body).toMatchObject({ message: "This organization's seats end on 2026-12-01. You can delete the organization after they end." });
  f.seats.unsettled.add(f.spaceId);
  expect(remove()?.body).toMatchObject({ message: "This organization's billing is still being updated. Wait for it to finish before deleting the organization." });
  f.seats.unsettled.clear();
  f.seats.seed(f.spaceId, { subscription: { ...subscription, standing: "ended" } });
  expect(remove()).toBeNull();
});
