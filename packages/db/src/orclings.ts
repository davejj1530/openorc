import { DEFAULT_CLAUDE_ACCOUNT, defaultOrclingLook, isHarnessId, OrclingLook, type Orcling, type OrclingDraft, type OrclingInstructionsVersion } from "@openorc/protocol";
import type { Db } from "./database.js";

interface OrclingRow {
  id: string;
  name: string;
  look: string;
  agent: string;
  model: string;
  effort: string | null;
  fast_mode: number;
  permission: "allow" | "approve";
  claude_account_id: string | null;
  thread_id: string;
  created_at: number;
  updated_at: number;
}

interface InstructionsRow {
  version: number;
  body: string;
  author: "user" | "orcling";
  note: string | null;
  created_at: number;
}

function parseLook(text: string): OrclingLook {
  try {
    return OrclingLook.parse(JSON.parse(text));
  } catch {
    return defaultOrclingLook;
  }
}

const toOrcling = (row: OrclingRow): Orcling => ({
  id: row.id,
  name: row.name,
  look: parseLook(row.look),
  settings: { agent: isHarnessId(row.agent) ? row.agent : "claude", model: row.model, effort: row.effort, fastMode: row.fast_mode === 1 },
  permission: row.permission,
  claudeAccountId: row.claude_account_id ?? DEFAULT_CLAUDE_ACCOUNT,
  threadId: row.thread_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toVersion = (row: InstructionsRow): OrclingInstructionsVersion => ({ version: row.version, body: row.body, author: row.author, note: row.note, createdAt: row.created_at });

export interface OrclingInsert {
  id: string;
  draft: OrclingDraft & { claudeAccountId: string };
  threadId: string;
}

export const orclings = {
  list(db: Db): Orcling[] {
    return (db.stmt("SELECT * FROM orclings ORDER BY created_at, id").all() as unknown as OrclingRow[]).map(toOrcling);
  },
  get(db: Db, id: string): Orcling | null {
    const row = db.stmt("SELECT * FROM orclings WHERE id = ?").get(id) as unknown as OrclingRow | undefined;
    return row ? toOrcling(row) : null;
  },
  /** The Orcling whose own conversation this is, if any. */
  forThread(db: Db, threadId: string): Orcling | null {
    const row = db.stmt("SELECT * FROM orclings WHERE thread_id = ?").get(threadId) as unknown as OrclingRow | undefined;
    return row ? toOrcling(row) : null;
  },
  insert(db: Db, input: OrclingInsert, now = Date.now()): Orcling {
    const { name, look, settings, permission, claudeAccountId } = input.draft;
    db.stmt("INSERT INTO orclings (id, name, look, agent, model, effort, fast_mode, permission, claude_account_id, thread_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      input.id,
      name,
      JSON.stringify(look),
      settings.agent,
      settings.model,
      settings.effort,
      settings.fastMode ? 1 : 0,
      permission,
      claudeAccountId,
      input.threadId,
      now,
      now,
    );
    return orclings.get(db, input.id)!;
  },
  update(db: Db, id: string, draft: OrclingDraft & { claudeAccountId: string }, now = Date.now()): Orcling | null {
    const { name, look, settings, permission, claudeAccountId } = draft;
    db.stmt("UPDATE orclings SET name = ?, look = ?, agent = ?, model = ?, effort = ?, fast_mode = ?, permission = ?, claude_account_id = ?, updated_at = ? WHERE id = ?").run(
      name,
      JSON.stringify(look),
      settings.agent,
      settings.model,
      settings.effort,
      settings.fastMode ? 1 : 0,
      permission,
      claudeAccountId,
      now,
      id,
    );
    return orclings.get(db, id);
  },
  delete(db: Db, id: string): void {
    db.stmt("DELETE FROM orclings WHERE id = ?").run(id);
  },
  /** Every version of an Orcling's instructions, newest first. */
  instructions(db: Db, id: string): OrclingInstructionsVersion[] {
    return (db.stmt("SELECT version, body, author, note, created_at FROM orcling_instructions WHERE orcling_id = ? ORDER BY version DESC").all(id) as unknown as InstructionsRow[]).map(toVersion);
  },
  currentInstructions(db: Db, id: string): OrclingInstructionsVersion | null {
    const row = db.stmt("SELECT version, body, author, note, created_at FROM orcling_instructions WHERE orcling_id = ? ORDER BY version DESC LIMIT 1").get(id) as unknown as
      InstructionsRow | undefined;
    return row ? toVersion(row) : null;
  },
  /** Saves a new newest version; earlier versions are never changed. */
  appendInstructions(db: Db, id: string, input: Pick<OrclingInstructionsVersion, "body" | "author" | "note">, now = Date.now()): OrclingInstructionsVersion {
    return db.transaction(() => {
      const { next } = db.stmt("SELECT COALESCE(MAX(version), 0) + 1 AS next FROM orcling_instructions WHERE orcling_id = ?").get(id) as { next: number };
      db.stmt("INSERT INTO orcling_instructions (orcling_id, version, body, author, note, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, next, input.body, input.author, input.note, now);
      return { version: next, body: input.body, author: input.author, note: input.note, createdAt: now };
    });
  },
};
