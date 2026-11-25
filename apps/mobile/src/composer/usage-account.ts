import { DEFAULT_CLAUDE_ACCOUNT, type PlanLimits } from "@openorc/protocol";

/*
 * Which account's limits a composer's meter measures, among those Settings > Usage reads. An account it cannot name
 * for certain shows none: never another account's usage.
 */

/** The Mac's account an agent runs on: its own, or for Claude the named account, else the only one the Mac has on. */
export function macAccount(accounts: readonly PlanLimits[], agent: string, claudeAccountId: string | undefined): PlanLimits | null {
  if (agent !== "claude") return accounts.find((account) => account.id === agent) ?? null;
  const claude = accounts.filter((account) => account.provider === "claude");
  return claude.find((account) => account.id === `claude:${claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT}`) ?? (claude.length === 1 ? claude[0]! : null);
}

/** The person's account on OpenOrc Cloud an agent runs on: the named one, else the agent's only sign-in there. */
export function cloudAccount(accounts: readonly PlanLimits[], agent: string, accountId: string | null | undefined): PlanLimits | null {
  const own = accounts.filter((account) => account.provider === agent);
  return own.find((account) => account.id === `cloud:${agent}:${accountId}`) ?? (own.length === 1 ? own[0]! : null);
}
