import { z } from "zod";
import type { ExecutionMode } from "./execution-mode.js";
import { FileScope } from "./files.js";
import { HarnessId } from "./harness.js";

/** Every agent can hold and address a connector under this name. */
export const ConnectorName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** What a connector runs: a command on this computer, or a server at an address. */
export const ConnectorSpec = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("command"), command: z.string().min(1), args: z.array(z.string()), env: z.record(z.string(), z.string()) }),
  z.object({ kind: z.literal("url"), url: z.string().url(), headers: z.record(z.string(), z.string()) }),
]);
export type ConnectorSpec = z.infer<typeof ConnectorSpec>;

export const ConnectorStatus = z.enum(["connected", "needs-sign-in", "failed", "off"]);
export type ConnectorStatus = z.infer<typeof ConnectorStatus>;

/** Who provides it, which decides what OpenOrc may change: only a `user` connector is the user's to edit or remove. */
export const ConnectorSource = z.enum(["user", "project", "plugin", "account"]);
export type ConnectorSource = z.infer<typeof ConnectorSource>;

/** How it stands in one place an agent runs: the only place, or for Claude, one account. */
export const ConnectorPlace = z.object({
  accountId: z.string().optional(),
  accountName: z.string().optional(),
  status: ConnectorStatus,
  error: z.string().optional(),
});
export type ConnectorPlace = z.infer<typeof ConnectorPlace>;

export const AgentConnector = z.object({
  agent: HarnessId,
  source: ConnectorSource,
  /** Whether OpenOrc may change it for this agent. */
  editable: z.boolean(),
  /** Whether it has a switch, which an agent's project and plugin servers may not. */
  switchable: z.boolean(),
  places: z.array(ConnectorPlace),
});
export type AgentConnector = z.infer<typeof AgentConnector>;

export const Connector = z.object({
  /** What the agents call it, and what `@` inserts. */
  name: z.string(),
  /** What people call it: `Figma` for `claude.ai Figma`. */
  title: z.string(),
  kind: z.enum(["command", "url"]).nullable(),
  /** An image as a data URL, safe to draw; without one the first letter of the title stands in. */
  logo: z.string().nullable(),
  agents: z.array(AgentConnector),
});
export type Connector = z.infer<typeof Connector>;

export const ConnectorSignIn = z.object({
  name: z.string(),
  agent: HarnessId,
  accountName: z.string().optional(),
  /** Sign-ins still to do after this one. */
  remaining: z.number().int().nonnegative(),
});
export type ConnectorSignIn = z.infer<typeof ConnectorSignIn>;

export const ConnectorList = z.object({
  connectors: z.array(Connector),
  /** Agents that could not answer, and why. */
  unavailable: z.array(z.object({ agent: HarnessId, reason: z.string() })),
  /** A read is under way, so what is here may change. */
  checking: z.boolean(),
  signIn: ConnectorSignIn.nullable(),
  /** Why the last sign-in did not finish. */
  signInError: z.string().nullable(),
});
export type ConnectorList = z.infer<typeof ConnectorList>;

/** Whether a thread's agent has the user's connectors in this mode, as each agent's launch decides. */
export function threadHasConnectors(agent: HarnessId, mode: ExecutionMode): boolean {
  if (mode === "plan") return false;
  return agent !== "claude" || mode === "autonomous";
}

/** One thing `@` can name in a thread. */
export interface UsableConnector {
  name: string;
  title: string;
  logo: string | null;
}

/** What a thread can name: connected for its agent, and for Claude on the account the thread runs on. */
export function usableConnectors(list: ConnectorList | undefined, agent: HarnessId, claudeAccountId: string | undefined): UsableConnector[] {
  return (list?.connectors ?? []).flatMap(({ name, title, logo, agents }) => {
    const places = agents.find((entry) => entry.agent === agent)?.places ?? [];
    const place = agent === "claude" && claudeAccountId ? places.filter((entry) => entry.accountId === claudeAccountId) : places;
    return place.some((entry) => entry.status === "connected") ? [{ name, title, logo }] : [];
  });
}

export const connectorRpcParams = {
  "connectors.list": z.object({ scope: FileScope.optional(), refresh: z.boolean().optional() }),
  "connectors.spec": z.object({ agent: HarnessId, name: ConnectorName }),
  /** `previousName` is what an edit started from, the same name unless it was renamed; without it, this adds a new connector. */
  "connectors.save": z.object({ name: ConnectorName, previousName: ConnectorName.optional(), spec: ConnectorSpec, agents: z.array(HarnessId) }),
  "connectors.remove": z.object({ name: ConnectorName }),
  "connectors.setOn": z.object({ agent: HarnessId, name: z.string().min(1), on: z.boolean() }),
  "connectors.signIn": z.object({ name: z.string().min(1) }),
  "connectors.cancelSignIn": z.object({}),
  "connectors.signOut": z.object({ name: z.string().min(1) }),
};

type ConnectorFailures = { failed: ConnectorList["unavailable"] };
export interface ConnectorRpcResults {
  "connectors.list": ConnectorList;
  "connectors.spec": ConnectorSpec | null;
  "connectors.save": ConnectorFailures;
  "connectors.remove": ConnectorFailures;
  "connectors.setOn": { ok: true };
  "connectors.signIn": { started: boolean };
  "connectors.cancelSignIn": { ok: true };
  "connectors.signOut": ConnectorFailures;
}
