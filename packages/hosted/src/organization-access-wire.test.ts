import { describe, expect, it } from "vitest";
import { wireBilling } from "./wire.js";
import { wireSpaces } from "./wire-spaces.js";
import { toPlan } from "./translate.js";

const until = "2026-11-15T06:05:00.000Z";
const grace = { state: "grace", reason: "seat_removed", until, message: "Your seat was taken back; you have one day to get Pro to keep using organizations." };
const billing = {
  pro: { status: "pro", standing: "grace", until, paidBy: { kind: "self" } },
  period: null,
  monthly: null,
  packs: [{ grantedSeconds: 7200, usedSeconds: 0, leftSeconds: 7200, boughtAt: "2026-10-01T00:00:00.000Z", expiresAt: "2027-10-01T00:00:00.000Z" }],
  leftSeconds: 3600,
};

describe("private organization access reads", () => {
  it("retains the private loss reason, authoritative deadline and selected allowance source", () => {
    const source = { kind: "organization", organizationId: "organization-one", organizationName: "Studio" };
    expect(wireBilling.parse({ ...billing, organizationAccess: grace, allowanceSource: source })).toMatchObject({ organizationAccess: grace, allowanceSource: source });
  });

  it("keeps membership with its account-wide access state", () => {
    const result = wireSpaces.parse({
      userId: "person-one",
      personalSpaceId: "personal",
      spaces: [{ kind: "personal", id: "personal" }],
      create: { allowed: true, reason: null },
      organizationAccess: grace,
    });
    expect(result).toMatchObject({ organizationAccess: grace });
  });

  it("accepts an old server without inventing an access state or payer", () => {
    expect(wireBilling.parse(billing)).not.toHaveProperty("organizationAccess");
    expect(wireBilling.parse(billing)).not.toHaveProperty("allowanceSource");
  });

  it.each([
    { ...grace, reason: "no_pro" },
    { ...grace, until: null },
    { ...grace, until: "not-a-date" },
    { state: "active", reason: "seat_removed", until: null, message: null },
    { state: "frozen", reason: "seat_removed", until, message: "Ended" },
  ])("refuses malformed access rather than silently granting it: %j", (access) => {
    expect(wireBilling.safeParse({ ...billing, organizationAccess: access }).success).toBe(false);
  });

  it("uses the usable total returned by billing, with no included hours during grace", () => {
    expect(toPlan(wireBilling.parse(billing)).hours).toEqual({ leftSeconds: 3600, monthly: null, packsLeftSeconds: 7200 });
  });

  it.each([0, 21600])("retains a confirmed frozen total of %i without altering old-server Free", (leftSeconds) => {
    const old = { ...billing, pro: { status: "free" }, leftSeconds, packs: [] };
    expect(toPlan(wireBilling.parse(old)).hours).toBeNull();
    const frozen = { state: "frozen", reason: "seat_removed", until: null, message: "Your seat was taken back, and your day of grace has ended." };
    expect(toPlan(wireBilling.parse({ ...old, organizationAccess: frozen })).hours).toEqual({ leftSeconds, monthly: null, packsLeftSeconds: 0 });
  });

  it("keeps never-paid Free unchanged when the explicit no_pro state has no bought hours", () => {
    const neverPaid = {
      ...billing,
      pro: { status: "free" },
      leftSeconds: 0,
      packs: [],
      organizationAccess: { state: "frozen", reason: "no_pro", until: null, message: "You need Pro to use an organization. Open Account or ask an admin for a seat." },
    };
    expect(toPlan(wireBilling.parse(neverPaid))).toEqual({ plan: { pro: false }, hours: null });
    expect(toPlan(wireBilling.parse({ ...neverPaid, leftSeconds: 21600 })).hours?.leftSeconds).toBe(21600);
  });
});
