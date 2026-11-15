import { SeatOperation, SeatQuantityPreview } from "@openorc/protocol";
import { z } from "zod";
import type { Route } from "./wire.js";

const iso = z.iso.datetime();
export const wireQuantityPreview = SeatQuantityPreview.extend({ expiresAt: iso, asOf: iso, at: iso, firstGrantEndsAt: iso.nullable() });

export function toQuantityPreview(read: z.infer<typeof wireQuantityPreview>): SeatQuantityPreview {
  return {
    ...read,
    expiresAt: Date.parse(read.expiresAt),
    asOf: Date.parse(read.asOf),
    at: Date.parse(read.at),
    firstGrantEndsAt: read.firstGrantEndsAt === null ? null : Date.parse(read.firstGrantEndsAt),
  };
}

const route = <T>(method: Route<T>["method"], path: string, reply: z.ZodType<T>): Route<T> => ({ method, path, reply });
export const SEAT_QUANTITY_ROUTES = {
  preview: route("POST", "/organization/billing/quantity/preview", wireQuantityPreview),
  confirm: route("PATCH", "/organization/billing/quantity", SeatOperation),
  operation: (id: string) => route("GET", `/organization/billing/operations/${encodeURIComponent(id)}`, SeatOperation),
};
