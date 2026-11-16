import { CLOUD_CHECK_STEPS } from "@openorc/protocol";
import { z } from "zod";
import type { Route } from "./wire.js";

const check = z.object({
  id: z.string(),
  startedAt: z.iso.datetime(),
  done: z.boolean(),
  service: z.string(),
  links: z.array(z.object({ step: z.enum(CLOUD_CHECK_STEPS), state: z.enum(["running", "ok", "broken", "unchecked"]), words: z.string().nullable(), ms: z.number().int().nonnegative().nullable() })),
  broken: z.enum(CLOUD_CHECK_STEPS).nullable(),
});
const reply = z.object({ check: check.nullable() });
export type WireCheckReply = z.infer<typeof reply>;

/** The person's cloud check: the last one, and a new one started. */
export const CHECK_ROUTES = {
  read: { method: "GET", path: "/hosted/check", reply } satisfies Route<WireCheckReply>,
  start: { method: "POST", path: "/hosted/check", reply } satisfies Route<WireCheckReply>,
};
