import { isHostedAgent, openCodeProvider, turnSignIn, type AccountSignIn, type AccountStatus, type TurnAccountSettings } from "@openorc/protocol";

/** One of the person's accounts on OpenOrc Cloud as an account picker lists it. */
export interface CloudAccountChoice {
  id: string;
  name: string;
  status: "ready" | "signed_out";
}

/**
 * The person's accounts on OpenOrc Cloud that a turn with these settings could run on, and the one it does: the one
 * the settings name when it is theirs, else their default. Null where the server keeps one sign-in per agent, or the
 * person has no account for the agent (for OpenCode, the provider its model names).
 */
export function cloudAccountChoices(account: AccountStatus | undefined, settings: TurnAccountSettings): { accounts: CloudAccountChoice[]; current: string } | null {
  if (account?.state !== "signed-in" || !account.agentAccounts || !account.signIns || !isHostedAgent(settings.agent)) return null;
  const provider = settings.agent === "opencode" ? openCodeProvider(settings.model) : null;
  const rows = account.signIns.filter((row): row is AccountSignIn & { id: string } => row.agent === settings.agent && row.id !== undefined && (provider === null || row.provider === provider));
  const current = turnSignIn(rows, settings)?.id;
  if (!current) return null;
  return { accounts: rows.map((row) => ({ id: row.id, name: row.name ?? row.label, status: row.ended ? "signed_out" : "ready" })), current };
}
