import { HostedConnectorAgent } from "@openorc/protocol";
import { z } from "zod";
import type { Route } from "./wire.js";

const connector = z.object({
  agent: HostedConnectorAgent,
  name: z.string().min(1),
  url: z.string(),
  headers: z.array(z.object({ name: z.string().min(1), updatedAt: z.iso.datetime() })),
  revision: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type WireConnector = z.infer<typeof connector>;
const connectors = z.object({ connectors: z.array(connector) });
const check = z.object({ status: z.enum(["connected", "refused", "failed"]), message: z.string().nullable() });
export type WireConnectorCheck = z.infer<typeof check>;

const of = (agent: string, name: string) => `/hosted/connectors/${encodeURIComponent(agent)}/${encodeURIComponent(name)}`;

/** A person's own cloud connectors: all of them to read, one agent's to save whole, remove or check. */
export const CONNECTOR_ROUTES = {
  read: { method: "GET", path: "/hosted/connectors", reply: connectors } satisfies Route<z.infer<typeof connectors>>,
  save: (agent: string, name: string): Route<WireConnector> => ({ method: "PUT", path: of(agent, name), reply: connector }),
  remove: (agent: string, name: string): Route<z.infer<typeof connectors>> => ({ method: "DELETE", path: of(agent, name), reply: connectors }),
  check: (agent: string, name: string): Route<WireConnectorCheck> => ({ method: "POST", path: `${of(agent, name)}/check`, reply: check }),
};
