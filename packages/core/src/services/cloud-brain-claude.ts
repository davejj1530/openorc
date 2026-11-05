import { claudeAccounts, type Db } from "@openorc/db";
import type { ClaudeCloudTokens } from "./claude-cloud-tokens.js";

/** A Claude account as handed to the brain, its token left out. */
export interface Sent {
  id: string;
  name: string;
  default: boolean;
  /** When the token sent was made or pasted. */
  tokenAt: number;
}

export const sameSent = (a: Sent[], b: Sent[]) => JSON.stringify(a) === JSON.stringify(b);

export function sent({ id, name, default: isDefault, tokenAt }: Sent): Sent {
  return { id, name, default: isDefault, tokenAt };
}

/** Every enabled Claude account with a cloud token, the default marked. One turned off here does not run there either. */
export async function claudeToSend(db: Db, tokens: Pick<ClaudeCloudTokens, "status" | "token">): Promise<(Sent & { token: string })[]> {
  const access = await tokens.status();
  const defaultId = claudeAccounts.defaultId(db);
  const accounts: (Sent & { token: string })[] = [];
  for (const { id, name } of claudeAccounts.list(db).filter((account) => account.enabled)) {
    const tokenAt = access[id]?.createdAt;
    const token = tokenAt == null ? null : await tokens.token(id);
    if (token && tokenAt != null) accounts.push({ id, name, default: id === defaultId, tokenAt, token });
  }
  return accounts;
}
