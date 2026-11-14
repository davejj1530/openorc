import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { wireSeatPreview } from "../organization-seat-assignment-wire.js";
import { StandInSeats } from "./stand-in-seats.js";
import { StandInSpaces } from "./stand-in-spaces.js";

function fixture() {
  let now = Date.parse("2026-11-01T00:00:00.000Z");
  const spaces = new StandInSpaces();
  const spaceId = spaces.addTeam("Example team", ["admin@example.com", "member@example.com"]);
  const seats = new StandInSeats({ spaces, now: () => now, origin: () => "https://example.com", tell: () => {} });
  seats.enabled = seats.assignments.enabled = true;
  const route = (method: string, path: string, body?: unknown) => seats.route({ method, path, space: spaceId, query: new URLSearchParams() }, "admin@example.com", body);
  route("POST", "/organization/billing/checkout", { plan: "monthly", seats: 2 });
  seats.pay(spaceId, { quiet: true });
  const record = seats.records.get(spaceId)!;
  const seat = record.seats[0]!;
  const memberId = spaces.member(spaceId, "member@example.com")!.id;
  const preview = (target: string | null) => wireSeatPreview.parse(route("POST", `/organization/seats/${seat.id}/preview`, { memberId: target })!.body);
  const assign = (token: string, id = randomUUID()) => ({ id, reply: route("PATCH", `/organization/seats/${seat.id}`, { id, previewToken: token }) });
  return {
    route,
    record,
    seat,
    seats,
    memberId,
    spaces,
    spaceId,
    preview,
    assign,
    advance: () => {
      now += 60_000;
    },
  };
}

it("moves the same seat remainder and never changes paid quantity when taking it back", () => {
  const f = fixture();
  const allowance = structuredClone(f.seat.included);
  const quantity = f.record.subscription!.quantity;
  expect(f.assign(f.preview(f.memberId).token).reply).toMatchObject({ status: 200, body: { state: "complete" } });
  expect(f.seat.assignment).toMatchObject({ kind: "member", memberId: f.memberId });
  expect(f.seat.included).toEqual(allowance);
  expect(f.assign(f.preview(null).token).reply).toMatchObject({ body: { state: "complete" } });
  expect(f.seat.assignment).toEqual({ kind: "available" });
  expect(f.seat.included).toEqual(allowance);
  expect(f.record.subscription!.quantity).toBe(quantity);
});

it("replays an identical completed request after preview expiry and refuses changed requests", () => {
  const f = fixture(),
    token = f.preview(f.memberId).token;
  const first = f.assign(token);
  f.advance();
  expect(f.assign(token, first.id).reply).toEqual(first.reply);
  expect(f.assign("different", first.id).reply?.status).toBe(409);
  expect(f.assign(token).reply?.status).toBe(409);
});

it("keeps a pending seat unchanged, then settles only once and blocks competing writes", () => {
  const f = fixture(),
    token = f.preview(f.memberId).token;
  f.seats.assignments.pending = true;
  const first = f.assign(token);
  expect(first.reply).toMatchObject({ body: { state: "pending" } });
  expect(f.seat.assignment.kind).toBe("available");
  expect(f.assign(token).reply?.status).toBe(409);
  f.seats.assignments.settle(first.id);
  const revision = f.record.revision;
  f.seats.assignments.settle(first.id);
  expect(f.record.revision).toBe(revision);
  expect(f.route("GET", `/organization/billing/operations/${first.id}`)).toMatchObject({ body: { state: "complete" } });
});

it("refuses a departed target and allows taking back a lapsed holder without a new grace deadline", () => {
  const f = fixture(),
    token = f.preview(f.memberId).token;
  f.spaces.removeMember(f.spaceId, "member@example.com");
  expect(f.assign(token).reply?.status).toBe(409);
  f.seat.assignment = { kind: "person", person: { id: "person-a", name: "Former member", email: "former@example.com", image: null }, paysForPro: false };
  f.record.subscription!.standing = "ended";
  f.seats.assignments.previousHolderAfter = "frozen";
  expect(f.preview(null)).toMatchObject({ previousHolderAfter: "frozen", graceUntil: null });
  expect(f.assign(f.preview(null).token).reply?.status).toBe(200);
});
