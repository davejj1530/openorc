import type { OrganizationSeat } from "@openorc/protocol";
import { expect, it } from "vitest";
import { chooseAvailableSeat } from "./seat-choice";

function seat(id: string, seconds: number): OrganizationSeat {
  return {
    id,
    assignment: { kind: "available" },
    period: { startsAt: 1, endsAt: 2 },
    included: { grantedSeconds: 360000, usedSeconds: 360000 - seconds, leftSeconds: seconds },
    retiresAt: null,
  };
}

it("chooses the fullest available seat without changing the inventory order or balance", () => {
  const seats = [seat("a", 7200), seat("b", 43200), seat("c", 21600)];
  const before = structuredClone(seats);
  expect(chooseAvailableSeat(seats)).toEqual({ state: "ready", seat: seats[1] });
  expect(seats).toEqual(before);
});

it("uses stable seat IDs when the remaining hours are equal", () => {
  const seats = [seat("seat-z", 3600), seat("seat-a", 3600)];
  expect(chooseAvailableSeat(seats)).toEqual({ state: "ready", seat: seats[1] });
});

it("excludes held, reserved, legacy nonmember and retiring seats", () => {
  const person = { id: "person-a", name: "Alex Example", email: "alex@example.com", image: null };
  const available = seat("available", 1800);
  const seats: OrganizationSeat[] = [
    { ...seat("held", 360000), assignment: { kind: "member", memberId: "member-a", person, paysForPro: false } },
    { ...seat("legacy", 360000), assignment: { kind: "person", person, paysForPro: false } },
    { ...seat("reserved", 360000), assignment: { kind: "invitation", invitationId: "invite-a", email: "sam@example.com", expiresAt: 2 } },
    { ...seat("retiring", 360000), retiresAt: 2 },
    available,
  ];
  expect(chooseAvailableSeat(seats)).toEqual({ state: "ready", seat: available });
});

it.each(["included", "period"] as const)("requires a fresh read when an available seat's %s is unknown", (field) => {
  const unknown = { ...seat("unknown", 360000), [field]: null };
  expect(chooseAvailableSeat([seat("known", 360000), unknown])).toEqual({ state: "unknown" });
});

it("keeps a confirmed zero allowance instead of inventing a fresh grant", () => {
  const available = seat("spent", 0);
  expect(chooseAvailableSeat([available])).toEqual({ state: "ready", seat: available });
});

it("reports empty only when there is no assignable slot", () => {
  expect(chooseAvailableSeat([])).toEqual({ state: "empty" });
  expect(chooseAvailableSeat([{ ...seat("retiring", 0), retiresAt: 2 }])).toEqual({ state: "empty" });
});
