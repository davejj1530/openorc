import { z } from "zod";
import type { Route } from "./wire.js";

const machines = z.object({
  machines: z.array(
    z.object({
      id: z.string(),
      serviceName: z.string(),
      since: z.iso.datetime(),
      seconds: z.number().int().nonnegative(),
      threads: z.array(z.object({ id: z.string(), title: z.string().nullable(), holds: z.array(z.enum(["turn", "terminal", "background", "resting"])) })),
      stop: z.discriminatedUnion("can", [z.object({ can: z.literal(true) }), z.object({ can: z.literal(false), reason: z.string().min(1) })]),
    }),
  ),
});
export type WireMachines = z.infer<typeof machines>;

/** The person's awake machines, in every space, and the stop of one. */
export const MACHINE_ROUTES = {
  read: { method: "GET", path: "/hosted/machines", reply: machines } satisfies Route<WireMachines>,
  stop: (id: string): Route<WireMachines> => ({ method: "POST", path: `/hosted/machines/${encodeURIComponent(id)}/stop`, reply: machines }),
};
