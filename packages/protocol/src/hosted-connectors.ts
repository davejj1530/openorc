import { z } from "zod";
import { HOSTED_AGENTS } from "./account.js";
import { ConnectorName } from "./connectors.js";

/**
 * A person's own connectors in their cloud turns: an HTTPS server for each agent that should have it, with the headers
 * it is asked with. The server keeps each value sealed and never sends one back: a connector shows each header's name
 * and when it was set.
 */
export const HostedConnectorAgent = z.enum(HOSTED_AGENTS);
export type HostedConnectorAgent = z.infer<typeof HostedConnectorAgent>;

/** How a connector answered its last check this session: it took its headers, it refused them, or it could not be asked. */
export type HostedConnectorCheck = { status: "connected" | "refused" | "failed"; message: string | null };

/** One agent's cloud connection of a connector. */
export type HostedConnector = {
  agent: HostedConnectorAgent;
  name: string;
  url: string;
  headers: { name: string; updatedAt: number }[];
  revision: number;
  updatedAt: number;
  /** Its last check this session, none before one. */
  check: HostedConnectorCheck | null;
};

/** The person's cloud connectors, or none where the server keeps no connectors. */
export type HostedConnectors = { state: "ready"; connectors: HostedConnector[] } | { state: "unavailable" };

/** A header to keep: a new value, or the one already saved under its name. */
const header = z.union([
  z
    .object({
      name: z.string().min(1).max(128),
      value: z
        .string()
        .min(1)
        .max(8 * 1024),
    })
    .strict(),
  z.object({ name: z.string().min(1).max(128), keep: z.literal(true) }).strict(),
]);

/** Window-only: a paired phone neither reads nor changes a person's cloud connectors. */
export const hostedConnectorsRpcParams = {
  "hostedConnectors.read": z.object({}).strict(),
  /**
   * Saves one connector for the agents given, each with the same address and headers, removes it from the agents it
   * had and is no longer given, and checks it once for the first agent. A header left out is removed.
   */
  "hostedConnectors.save": z.object({ name: ConnectorName, url: z.string().url().max(2048), headers: z.array(header).max(20), agents: z.array(HostedConnectorAgent).min(1) }).strict(),
  /** Removes one connector from every agent's cloud connections. */
  "hostedConnectors.remove": z.object({ name: ConnectorName }).strict(),
};
export interface HostedConnectorsRpcResults {
  "hostedConnectors.read": HostedConnectors;
  "hostedConnectors.save": HostedConnectors;
  "hostedConnectors.remove": HostedConnectors;
}
