import { randomUUID } from "node:crypto";
import { ClaudeAccount, DEFAULT_CLAUDE_ACCOUNT } from "@openorc/protocol";
import { z } from "zod";
import type { Db } from "./database.js";
import { settings } from "./memories.js";

const columns = "id, name, kind, enabled, created_at AS createdAt";
const row = ClaudeAccount.extend({ enabled: z.union([z.literal(0), z.literal(1)]).transform(Boolean) });
const defaultKey = "claude.defaultAccountId";

export const claudeAccounts = {
  list(db: Db): ClaudeAccount[] {
    return z.array(row).parse(db.stmt(`SELECT ${columns} FROM claude_accounts ORDER BY created_at, id`).all());
  },
  get(db: Db, id: string): ClaudeAccount {
    const value = db.stmt(`SELECT ${columns} FROM claude_accounts WHERE id = ?`).get(id);
    if (!value) throw new Error("This Claude account is no longer available. Choose an account in Settings → Connections.");
    return row.parse(value);
  },
  defaultId(db: Db): string {
    return settings.get(db, defaultKey) ?? DEFAULT_CLAUDE_ACCOUNT;
  },
  add(db: Db, name: string): ClaudeAccount {
    const account = ClaudeAccount.parse({ id: randomUUID(), name, kind: "managed", enabled: true, createdAt: Date.now() });
    db.stmt("INSERT INTO claude_accounts (id, name, kind, enabled, created_at) VALUES (?, ?, ?, 1, ?)").run(account.id, account.name, account.kind, account.createdAt);
    return account;
  },
  update(db: Db, input: { id: string; name?: string; enabled?: boolean; makeDefault?: true }): ClaudeAccount {
    return db.transaction(() => {
      const account = ClaudeAccount.parse({
        ...claudeAccounts.get(db, input.id),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      });
      if (!account.enabled && (input.makeDefault || claudeAccounts.defaultId(db) === account.id)) throw new Error("Choose another default account before disabling this one.");
      db.stmt("UPDATE claude_accounts SET name = ?, enabled = ? WHERE id = ?").run(account.name, Number(account.enabled), account.id);
      if (input.makeDefault) settings.set(db, defaultKey, account.id);
      return account;
    });
  },
};
