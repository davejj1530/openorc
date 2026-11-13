import { sessionSlots, type AgentHome, type SessionSlot } from "@openorc/agents";
import type { BrokeredHeader } from "@openorc/cloud";
import type { CloudProviderId } from "@openorc/db";
import { harnessIds, type HarnessId } from "@openorc/protocol";

/** Who a cloud turn runs as: the thread's Claude account, and the model whose provider signs it in. */
export interface CloudRunWho {
  claudeAccountId: string | null;
  model: string | null;
}

/**
 * What a turn signs its agent in with. Brokered, the variables and any file the sign-in wrote hold stand-ins that work
 * nowhere, and `headers` carry the real sign-in for the sandbox's firewall to add on the way out; otherwise the agent
 * holds its sign-in and `headers` is empty.
 */
export interface TurnSignIn {
  env: Record<string, string>;
  headers: BrokeredHeader[];
}

/** In place of a secret the firewall adds outside the sandbox: says so to anyone who finds it, and signs in nowhere. */
export const OUTSIDE_THE_SANDBOX = "openorc-sign-in-kept-outside-this-sandbox";

/** Signed in by what the agent holds itself. */
export const held = (env: Record<string, string>): TurnSignIn => ({ env, headers: [] });

/** How one agent signs in for a turn in a sandbox. Credentials never sit in its home's folder variables. */
export interface CloudSignIn {
  /** Refuses, changing nothing, when the agent cannot sign in on `provider` for this run. */
  assertCanRun(provider: CloudProviderId, who: CloudRunWho): Promise<void>;
  /** Its folder variables in a sandbox, under the runner's state folder; null when it uses this host's own folders. */
  homeEnv(state: string, provider: CloudProviderId, who: CloudRunWho): Promise<Record<string, string> | null>;
  /**
   * Before a turn: credentials in place. `brokered` asks for stand-ins in the sandbox and the real sign-in as headers
   * for its firewall, when the agent's sign-in can travel that way.
   */
  prepare(home: () => Promise<AgentHome | null>, provider: CloudProviderId, who: CloudRunWho, brokered: boolean): Promise<TurnSignIn>;
  /** After a turn: a credential the CLI refreshed there comes back. Stand-ins never do. */
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
  prepare: async () => held({}),
  keep: async () => undefined,
};

function localOnly(name: string): CloudSignIn {
  const unavailable = async (): Promise<never> => {
    throw new Error(`${name} runs on the connected computer. Cloud execution is not supported yet.`);
  };
  return { assertCanRun: unavailable, homeEnv: unavailable, prepare: unavailable, keep: async () => undefined };
}
export const LOCAL_ONLY_SIGN_INS = { cursor: localOnly("Cursor"), pi: localOnly("Pi"), antigravity: localOnly("Antigravity"), fx: localOnly("fx") };
export const { cursor: CURSOR_LOCAL_ONLY, pi: PI_LOCAL_ONLY, antigravity: ANTIGRAVITY_LOCAL_ONLY } = LOCAL_ONLY_SIGN_INS;
