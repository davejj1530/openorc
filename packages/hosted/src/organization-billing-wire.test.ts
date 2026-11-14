import { describe, expect, it } from "vitest";
import { ORGANIZATION_BILLING_ROUTES, toOrganizationBilling, wireOrganizationBilling, type WireOrganizationBilling } from "./organization-billing-wire.js";

const start = "2026-11-01T00:00:00.000Z";
const reset = "2026-12-01T00:00:00.000Z";
const renew = "2027-11-01T00:00:00.000Z";
const snapshot: WireOrganizationBilling = {
  organization: { id: "team-a", name: "Example team", logo: null },
  revision: "revision-1",
  asOf: start,
  subscription: { id: "subscription-a", plan: "yearly", standing: "live", paidUntil: renew, graceUntil: null, quantity: 3, overallocated: false, pendingQuantity: { quantity: 2, at: renew } },
  seats: [
    { id: "available-a", assignment: { kind: "available" }, period: { startsAt: start, endsAt: reset }, included: { grantedSeconds: 60480, usedSeconds: 3600, leftSeconds: 56880 }, retiresAt: renew },
    {
      id: "member-a",
      assignment: { kind: "member", memberId: "member-1", person: { id: "person-1", name: "Example person", email: "person@example.com", image: null }, paysForPro: true },
      period: { startsAt: start, endsAt: reset },
      included: { grantedSeconds: 360000, usedSeconds: 600, leftSeconds: 359400 },
      retiresAt: null,
    },
    { id: "invitation-a", assignment: { kind: "invitation", invitationId: "invite-1", email: "invitee@example.com", expiresAt: reset }, period: null, included: null, retiresAt: null },
  ],
  available: 0,
};

describe("organization billing boundary", () => {
  it("normalizes all dates and keeps monthly allowance separate from yearly payment", () => {
    const result = toOrganizationBilling(wireOrganizationBilling.parse(snapshot));
    expect(result).toMatchObject({ asOf: Date.parse(start), subscription: { paidUntil: Date.parse(renew), pendingQuantity: { at: Date.parse(renew) } } });
    expect(result.seats[0]).toMatchObject({ period: { startsAt: Date.parse(start), endsAt: Date.parse(reset) }, retiresAt: Date.parse(renew), included: snapshot.seats[0]?.included });
    expect(result.seats[1]).toMatchObject({ assignment: snapshot.seats[1]?.assignment, included: snapshot.seats[1]?.included });
    expect(result.seats[2]).toMatchObject({ assignment: { expiresAt: Date.parse(reset) }, period: null, included: null });
    expect(result.available).toBe(0);
  });

  it("preserves an overallocated legacy subscription without inventing new grants", () => {
    const result = toOrganizationBilling(wireOrganizationBilling.parse({ ...snapshot, subscription: { ...snapshot.subscription, overallocated: true, quantity: 2 } }));
    expect(result.subscription?.overallocated).toBe(true);
    expect(result.seats).toHaveLength(3);
    expect(result.seats[0]?.included?.grantedSeconds).toBe(60480);
  });

  it("retains a legacy holder without inventing a membership", () => {
    const assignment = { kind: "person", person: { id: "former-holder", name: "Example person", email: "former@example.com", image: null }, paysForPro: false };
    const result = toOrganizationBilling(wireOrganizationBilling.parse({ ...snapshot, seats: [{ ...snapshot.seats[0], assignment }] }));
    expect(result.seats[0]?.assignment).toEqual(assignment);
    expect(result.seats[0]?.included).toEqual(snapshot.seats[0]?.included);
  });

  it.each(["asOf", "period", "subscription"])("rejects a malformed %s date", (field) => {
    const read = structuredClone(snapshot);
    if (field === "asOf") read.asOf = "tomorrow";
    if (field === "period") read.seats[0]!.period!.endsAt = "tomorrow";
    if (field === "subscription") read.subscription!.paidUntil = "tomorrow";
    expect(wireOrganizationBilling.safeParse(read).success).toBe(false);
  });

  it("reads exact server totals and unknown prices without multiplying them", () => {
    const reply = ORGANIZATION_BILLING_ROUTES.offers(3).reply;
    const offers = {
      offers: [
        { plan: "monthly", seats: 3, price: { amount: 4577, currency: "eur" } },
        { plan: "yearly", seats: 3, price: null },
      ],
      monthlySeconds: 360000,
      maxSeats: 100,
    };
    expect(reply?.parse(offers)).toEqual(offers);
    expect(ORGANIZATION_BILLING_ROUTES.offers(3).path).toBe("/organization/billing/offers?seats=3");
  });
});
