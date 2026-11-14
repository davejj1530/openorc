import { expect, it } from "vitest";
import { SEAT_ASSIGNMENT_ROUTES, toSeatPreview, wireSeatPreview } from "./organization-seat-assignment-wire.js";

const preview = {
  token: "preview-a",
  asOf: "2026-11-01T03:05:00.000Z",
  expiresAt: "2026-11-01T03:06:00.000Z",
  seat: {
    id: "seat-a",
    assignment: { kind: "member", memberId: "member-a", person: { id: "person-a", name: "Sam Example", email: "sam@example.com", image: null }, paysForPro: false },
    period: { startsAt: "2026-10-15T03:05:00.000Z", endsAt: "2026-11-15T03:05:00.000Z" },
    included: { grantedSeconds: 360000, usedSeconds: 196123, leftSeconds: 163877 },
    retiresAt: null,
  },
  to: { memberId: "member-b", person: { id: "person-b", name: "Alex Example", email: "alex@example.com", image: null } },
  previousHolderAfter: "grace",
  graceUntil: "2026-11-02T03:05:00.000Z",
  runningTurnsToStop: 2,
};

it("retains the exact allowance snapshot and converts only server dates", () => {
  const read = toSeatPreview(wireSeatPreview.parse(preview));
  expect(read.seat.included).toEqual(preview.seat.included);
  expect(read).toMatchObject({ token: preview.token, asOf: Date.parse(preview.asOf), expiresAt: Date.parse(preview.expiresAt), graceUntil: Date.parse(preview.graceUntil), runningTurnsToStop: 2 });
  expect(read.seat.period?.endsAt).toBe(Date.parse(preview.seat.period.endsAt));
});

it("keeps an unknown allowance unknown and a surviving Pro source private", () => {
  const read = toSeatPreview(
    wireSeatPreview.parse({
      ...preview,
      seat: { ...preview.seat, included: null, period: null },
      previousHolderAfter: "pro",
      graceUntil: null,
      previousHolderPayer: { organizationName: "Another team" },
    }),
  );
  expect(read).toMatchObject({ previousHolderAfter: "pro", graceUntil: null, seat: { included: null, period: null } });
  expect(read).not.toHaveProperty("previousHolderPayer");
  expect(JSON.stringify(read)).not.toContain("Another team");
});

it("accepts taking back a legacy holder without inventing membership", () => {
  const { memberId: _memberId, ...assignment } = preview.seat.assignment;
  const read = toSeatPreview(wireSeatPreview.parse({ ...preview, seat: { ...preview.seat, assignment: { ...assignment, kind: "person" } }, to: null }));
  expect(read.to).toBeNull();
  expect(read.seat.assignment.kind).toBe("person");
  expect(read.seat.assignment).not.toHaveProperty("memberId");
});

it("refuses invalid times or negative running turns before showing a preview", () => {
  expect(wireSeatPreview.safeParse({ ...preview, expiresAt: "later" }).success).toBe(false);
  expect(wireSeatPreview.safeParse({ ...preview, runningTurnsToStop: -1 }).success).toBe(false);
});

it("encodes explicit identifiers and keeps mutations separate from polling", () => {
  expect(SEAT_ASSIGNMENT_ROUTES.preview("seat/a")).toMatchObject({ method: "POST", path: "/organization/seats/seat%2Fa/preview" });
  expect(SEAT_ASSIGNMENT_ROUTES.assign("seat/a")).toMatchObject({ method: "PATCH", path: "/organization/seats/seat%2Fa" });
  expect(SEAT_ASSIGNMENT_ROUTES.operation("change/a")).toMatchObject({ method: "GET", path: "/organization/billing/operations/change%2Fa" });
});
