import { z } from "zod";

export const DEFAULT_CLAUDE_ACCOUNT = "claude-cli";
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
