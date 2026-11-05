import { sessionSlots, type AgentHome, type SessionSlot } from "@openorc/agents";
import type { CloudProviderId } from "@openorc/db";
import { harnessIds, type HarnessId } from "@openorc/protocol";

/** Who a cloud turn runs as: the thread's Claude account, and the model whose provider signs it in. */
export interface CloudRunWho {
  claudeAccountId: string | null;
  model: string | null;
}

/** How one agent signs in for a turn in a sandbox. Credentials never sit in its home's folder variables. */
export interface CloudSignIn {
  /** Refuses, changing nothing, when the agent cannot sign in on `provider` for this run. */
  assertCanRun(provider: CloudProviderId, who: CloudRunWho): Promise<void>;
  /** Its folder variables in a sandbox, under the runner's state folder; null when it uses this host's own folders. */
  homeEnv(state: string, provider: CloudProviderId, who: CloudRunWho): Promise<Record<string, string> | null>;
  /** Before a turn: credentials in place; resolves with the credential part of the process environment. */
  prepare(home: () => Promise<AgentHome | null>, provider: CloudProviderId, who: CloudRunWho): Promise<Record<string, string>>;
  /** After a turn: a credential the CLI refreshed there comes back. */
  keep(home: () => Promise<AgentHome | null>, provider: CloudProviderId): Promise<void>;
}

export interface CloudAgent {
  readonly slot: SessionSlot;
  readonly signIn: CloudSignIn;
}
export type CloudAgents = { readonly [A in HarnessId]: CloudAgent };

/** Each agent with its session slot. */
export function cloudAgents(signIns: { readonly [A in HarnessId]: CloudSignIn }): CloudAgents {
  return Object.fromEntries(harnessIds.map((id) => [id, { slot: sessionSlots[id], signIn: signIns[id] }])) as unknown as CloudAgents;
}

/** An agent signed in by the sandbox's own environment, as sandboxes made for tests are. */
export const SANDBOX_OWN: CloudSignIn = {
  assertCanRun: async () => undefined,
  homeEnv: async () => ({}),
  prepare: async () => ({}),
  keep: async () => undefined,
};
