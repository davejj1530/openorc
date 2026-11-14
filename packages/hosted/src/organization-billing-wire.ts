import { OrganizationBilling, OrganizationBillingOffers, OrganizationSeat } from "@openorc/protocol";
import { z } from "zod";
import type { Route } from "./wire.js";
import { wireBillingLink } from "./wire.js";

const iso = z.iso.datetime();
const seat = OrganizationSeat.extend({
  assignment: z.discriminatedUnion("kind", [
    OrganizationSeat.shape.assignment.options[0],
    OrganizationSeat.shape.assignment.options[1],
    OrganizationSeat.shape.assignment.options[2].extend({ expiresAt: iso }),
    OrganizationSeat.shape.assignment.options[3],
  ]),
  period: z.object({ startsAt: iso, endsAt: iso }).nullable(),
  retiresAt: iso.nullable(),
});
export const wireOrganizationBilling = OrganizationBilling.extend({
  asOf: iso,
  subscription: OrganizationBilling.shape.subscription
    .unwrap()
    .extend({
      paidUntil: iso.nullable(),
      graceUntil: iso.nullable(),
      pendingQuantity: z.object({ quantity: z.number().int().nonnegative(), at: iso }).nullable(),
    })
    .nullable(),
  seats: z.array(seat),
});
export type WireOrganizationBilling = z.infer<typeof wireOrganizationBilling>;

const time = (value: string | null) => (value === null ? null : Date.parse(value));

export function toOrganizationBilling(read: WireOrganizationBilling): OrganizationBilling {
  return {
    ...read,
    asOf: Date.parse(read.asOf),
    subscription: read.subscription && {
      ...read.subscription,
      paidUntil: time(read.subscription.paidUntil),
      graceUntil: time(read.subscription.graceUntil),
      pendingQuantity: read.subscription.pendingQuantity && { ...read.subscription.pendingQuantity, at: Date.parse(read.subscription.pendingQuantity.at) },
    },
    seats: read.seats.map((row) => ({
      ...row,
      assignment: row.assignment.kind === "invitation" ? { ...row.assignment, expiresAt: Date.parse(row.assignment.expiresAt) } : row.assignment,
      period: row.period && { startsAt: Date.parse(row.period.startsAt), endsAt: Date.parse(row.period.endsAt) },
      retiresAt: time(row.retiresAt),
    })),
  };
}

const route = <T>(method: Route<T>["method"], path: string, reply: z.ZodType<T>): Route<T> => ({ method, path, reply });

export const ORGANIZATION_BILLING_ROUTES = {
  get: route("GET", "/organization/billing", wireOrganizationBilling),
  offers: (seats: number) => route("GET", `/organization/billing/offers?seats=${seats}`, OrganizationBillingOffers),
  checkout: route("POST", "/organization/billing/checkout", wireBillingLink),
  portal: route("POST", "/organization/billing/portal", wireBillingLink),
};
