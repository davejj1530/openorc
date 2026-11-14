import { z } from "zod";
import { SpaceId } from "./spaces.js";

const time = z.number().int().nonnegative();
const count = z.number().int().nonnegative();
const plan = z.enum(["monthly", "yearly"]);
const purchaseCount = z.number().int().min(1).max(100);
const price = z.object({ amount: count, currency: z.string().min(1) }).nullable();
const person = z.object({ id: z.string(), name: z.string(), email: z.string(), image: z.string().nullable() });

export const OrganizationSeat = z.object({
  id: z.string().min(1),
  assignment: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("available") }),
    z.object({ kind: z.literal("member"), memberId: z.string(), person, paysForPro: z.boolean() }),
    z.object({ kind: z.literal("invitation"), invitationId: z.string(), email: z.string(), expiresAt: time }),
    z.object({ kind: z.literal("person"), person, paysForPro: z.boolean() }),
  ]),
  period: z.object({ startsAt: time, endsAt: time }).nullable(),
  included: z.object({ grantedSeconds: count, usedSeconds: count, leftSeconds: count }).nullable(),
  retiresAt: time.nullable(),
});
export type OrganizationSeat = z.infer<typeof OrganizationSeat>;

/** Admin-only capacity and allowance snapshots. Dates are epoch milliseconds, never computed from a plan. */
export const OrganizationBilling = z.object({
  organization: z.object({ id: z.string(), name: z.string(), logo: z.string().nullable() }),
  revision: z.string(),
  asOf: time,
  subscription: z
    .object({
      id: z.string(),
      plan,
      standing: z.enum(["live", "ending", "grace", "ended"]),
      paidUntil: time.nullable(),
      graceUntil: time.nullable(),
      quantity: count,
      overallocated: z.boolean(),
      pendingQuantity: z.object({ quantity: count, at: time }).nullable(),
    })
    .nullable(),
  seats: z.array(OrganizationSeat),
  available: count,
});
export type OrganizationBilling = z.infer<typeof OrganizationBilling>;

/** Prices are totals for the requested count, in the server's currency minor units. */
export const OrganizationBillingOffers = z.object({
  offers: z.array(z.object({ plan, seats: purchaseCount, price })),
  monthlySeconds: z.number().int().positive(),
  maxSeats: z.number().int().positive(),
});
export type OrganizationBillingOffers = z.infer<typeof OrganizationBillingOffers>;

export const OrganizationBillingPage = z.discriminatedUnion("page", [
  z.object({ page: z.literal("checkout"), plan, seats: purchaseCount }).strict(),
  z.object({ page: z.literal("billing") }).strict(),
]);
export type OrganizationBillingPage = z.infer<typeof OrganizationBillingPage>;

/** An unresolved request survives leaving the temporary watch. The page address stays in core. */
export type OrganizationPayment = {
  id: string;
  target: OrganizationBillingPage;
  since: number;
  watching: boolean;
} & ({ state: "pending" | "waiting" | "complete"; error: string | null } | { state: "failed"; error: string });

export interface OrganizationBillingStatus {
  billing: OrganizationBilling | null;
  payment: OrganizationPayment | null;
  error: string | null;
}

export const organizationBillingRpcParams = {
  "organization.billing.get": z.object({ spaceId: SpaceId }).strict(),
  "organization.billing.offers": z.object({ spaceId: SpaceId, seats: purchaseCount }).strict(),
  "organization.billing.open": z.object({ spaceId: SpaceId, target: OrganizationBillingPage }).strict(),
  "organization.billing.leave": z.object({ spaceId: SpaceId }).strict(),
};
export type OrganizationBillingParams<M extends keyof typeof organizationBillingRpcParams> = z.infer<(typeof organizationBillingRpcParams)[M]>;
export interface OrganizationBillingRpcResults {
  "organization.billing.get": OrganizationBillingStatus;
  "organization.billing.offers": OrganizationBillingOffers;
  "organization.billing.open": OrganizationBillingStatus;
  "organization.billing.leave": OrganizationBillingStatus;
}
