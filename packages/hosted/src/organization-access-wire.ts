import { OrganizationAccess, type AccountStatus } from "@openorc/protocol";
import { z } from "zod";
import type { WireBilling } from "./wire.js";

export const wireOrganizationAccess = z.discriminatedUnion("state", [OrganizationAccess.options[0], OrganizationAccess.options[1].extend({ until: z.iso.datetime() }), OrganizationAccess.options[2]]);

export function toOrganizationAccess(access: z.infer<typeof wireOrganizationAccess>): OrganizationAccess {
  return access.state === "grace" ? { ...access, until: Date.parse(access.until) } : access;
}

/** Preserve absence for older servers, and never expose the private payer's identifier. */
export function accountSeatFacts(billing: WireBilling | null | undefined): Pick<Extract<AccountStatus, { state: "signed-in" }>, "organizationAccess" | "allowanceSource" | "paidBy"> {
  if (!billing) return {};
  return {
    ...(billing.organizationAccess !== undefined && { organizationAccess: toOrganizationAccess(billing.organizationAccess) }),
    ...(billing.allowanceSource !== undefined && { allowanceSource: billing.allowanceSource }),
    paidBy: billing.pro.status === "pro" ? billing.pro.paidBy.kind : null,
  };
}
