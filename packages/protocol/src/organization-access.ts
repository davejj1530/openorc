import { z } from "zod";

export const ProLossReason = z.enum(["no_pro", "payment_failed", "seat_removed", "subscription_ended"]);
export type ProLossReason = z.infer<typeof ProLossReason>;

/** The person's access to organization content. A grace deadline uses epoch milliseconds. */
export const OrganizationAccess = z.discriminatedUnion("state", [
  z.object({ state: z.literal("active"), reason: z.null(), until: z.null(), message: z.null() }),
  z.object({ state: z.literal("grace"), reason: ProLossReason.exclude(["no_pro"]), until: z.number().int().nonnegative(), message: z.string() }),
  z.object({ state: z.literal("frozen"), reason: ProLossReason, until: z.null(), message: z.string() }),
]);
export type OrganizationAccess = z.infer<typeof OrganizationAccess>;

/** Only the signed-in person receives the name funding their selected allowance. */
export const AllowanceSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("self") }),
  z.object({ kind: z.literal("organization"), organizationId: z.string(), organizationName: z.string() }),
]);
export type AllowanceSource = z.infer<typeof AllowanceSource>;
