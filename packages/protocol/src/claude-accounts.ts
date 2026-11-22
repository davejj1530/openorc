import { z } from "zod";

export const DEFAULT_CLAUDE_ACCOUNT = "claude-cli";

/** The reason the core and the apps give for what they hold back while accounts are kept separate. */
export const ACCOUNTS_KEPT_SEPARATE = "Settings keeps Claude accounts separate";

/** Why a group chat of Orclings on different Claude accounts takes no message while accounts are kept separate. */
export const GROUP_ACROSS_ACCOUNTS = `This group's Orclings work on different Claude accounts, and ${ACCOUNTS_KEPT_SEPARATE}, so it waits until that's off.`;

/** Why work can't start on the Claude account it carries over, `name`, once its project no longer uses it while accounts are kept separate. */
export function notCarriedOver(name: string): string {
  return `This project doesn't use ${name}, and ${ACCOUNTS_KEPT_SEPARATE}, so this can't start on another account.`;
}

export const ClaudeAccountId = z.string().min(1).max(100);
export const ClaudeAccount = z.object({
  id: ClaudeAccountId,
  name: z.string().trim().min(1).max(80),
  kind: z.enum(["cli", "managed"]),
  enabled: z.boolean(),
  createdAt: z.number(),
});
export type ClaudeAccount = z.infer<typeof ClaudeAccount>;

export interface ClaudeAccountConnection extends ClaudeAccount {
  status: "ready" | "signed_out" | "signing_in" | "unavailable" | "disabled";
  email: string | null;
  organization: string | null;
  message: string | null;
}
export interface ClaudeAccounts {
  accounts: ClaudeAccountConnection[];
  defaultId: string;
}

export const claudeAccountRpcParams = {
  "claude.accounts.list": z.object({ refresh: z.boolean().optional() }),
  "claude.accounts.add": z.object({ name: ClaudeAccount.shape.name }),
  "claude.accounts.update": z.object({ id: ClaudeAccountId, name: ClaudeAccount.shape.name.optional(), enabled: z.boolean().optional(), makeDefault: z.literal(true).optional() }),
  "claude.accounts.login": z.object({ id: ClaudeAccountId }),
  "claude.accounts.cancelLogin": z.object({ id: ClaudeAccountId }),
};
export interface ClaudeAccountRpcResults {
  "claude.accounts.list": ClaudeAccounts;
  "claude.accounts.add": ClaudeAccount;
  "claude.accounts.update": ClaudeAccount;
  "claude.accounts.login": { started: boolean };
  "claude.accounts.cancelLogin": { cancelled: boolean };
}
