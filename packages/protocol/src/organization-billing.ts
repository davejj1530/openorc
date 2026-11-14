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

export const OrganizationSeatPreview = z.object({
  token: z.string().min(1),
  expiresAt: time,
  asOf: time,
  seat: OrganizationSeat,
  to: z.object({ memberId: z.string(), person }).nullable(),
  previousHolderAfter: z.enum(["pro", "grace", "frozen"]).nullable(),
  graceUntil: time.nullable(),
  runningTurnsToStop: count,
});
export type OrganizationSeatPreview = z.infer<typeof OrganizationSeatPreview>;

export const SeatOperation = z.object({
  id: z.string().min(1),
  kind: z.enum(["quantity", "assignment"]),
  state: z.enum(["pending", "complete", "failed"]),
  message: z.string().nullable(),
});
export type SeatOperation = z.infer<typeof SeatOperation>;

/** Admins may read this fact for teammates; members may read only their own. */
export const OrganizationPersonSeat = z.object({ id: z.string().min(1).nullable(), paysForPro: z.boolean() });
export type OrganizationPersonSeat = z.infer<typeof OrganizationPersonSeat>;

export const SeatAssignmentTarget = z.object({ seatId: z.string().min(1), memberId: z.string().min(1).nullable() }).strict();
export type SeatAssignmentTarget = z.infer<typeof SeatAssignmentTarget>;

export const SeatAssignmentRequest = z
  .object({
    seatId: z.string().min(1),
    body: z.object({ id: z.uuid(), previewToken: z.string().min(1) }).strict(),
  })
  .strict();
export type SeatAssignmentRequest = z.infer<typeof SeatAssignmentRequest>;

/** Private core journal projection. It contains the exact request, never a person's billing details. */
export const SeatAssignmentWork = z
  .object({ request: SeatAssignmentRequest, operation: SeatOperation.nullable(), error: z.string().nullable() })
  .strict()
  .refine((value) => value.operation === null || (value.operation.kind === "assignment" && value.operation.id === value.request.body.id));
export type SeatAssignmentWork = z.infer<typeof SeatAssignmentWork>;

/** A structured authority loss clears private renderer state even before the roster catches up. */
export type OrganizationSeatReply<T> = { state: "ready"; value: T } | { state: "denied"; message: string };

export const organizationSeatRpcParams = {
  "organization.seat.preview": z.strictObject({ spaceId: SpaceId, target: SeatAssignmentTarget }),
  "organization.seat.assign": z.strictObject({ spaceId: SpaceId, request: SeatAssignmentRequest }),
  "organization.billing.operation": z.strictObject({ spaceId: SpaceId, id: z.uuid() }),
};
export interface OrganizationSeatRpcResults {
  "organization.seat.preview": OrganizationSeatReply<OrganizationSeatPreview>;
  "organization.seat.assign": OrganizationSeatReply<SeatAssignmentWork>;
  "organization.billing.operation": OrganizationSeatReply<SeatAssignmentWork | null>;
}

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
  assignments?: SeatAssignmentWork[];
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
