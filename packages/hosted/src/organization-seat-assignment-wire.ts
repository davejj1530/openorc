import { OrganizationSeatPreview, SeatOperation } from "@openorc/protocol";
import { z } from "zod";
import { toOrganizationSeat, wireOrganizationSeat } from "./organization-billing-wire.js";
import type { Route } from "./wire.js";

const iso = z.iso.datetime();
export const wireSeatPreview = OrganizationSeatPreview.extend({
  expiresAt: iso,
  asOf: iso,
  seat: wireOrganizationSeat,
  graceUntil: iso.nullable(),
});

export function toSeatPreview(read: z.infer<typeof wireSeatPreview>): OrganizationSeatPreview {
  return {
    ...read,
    expiresAt: Date.parse(read.expiresAt),
    asOf: Date.parse(read.asOf),
    seat: toOrganizationSeat(read.seat),
    graceUntil: read.graceUntil === null ? null : Date.parse(read.graceUntil),
  };
}

const route = <T>(method: Route<T>["method"], path: string, reply: z.ZodType<T>): Route<T> => ({ method, path, reply });
export const SEAT_ASSIGNMENT_ROUTES = {
  preview: (seatId: string) => route("POST", `/organization/seats/${encodeURIComponent(seatId)}/preview`, wireSeatPreview),
  assign: (seatId: string) => route("PATCH", `/organization/seats/${encodeURIComponent(seatId)}`, SeatOperation),
  operation: (id: string) => route("GET", `/organization/billing/operations/${encodeURIComponent(id)}`, SeatOperation),
};
