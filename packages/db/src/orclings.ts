import {
  DEFAULT_CLAUDE_ACCOUNT,
  defaultOrclingLook,
  isHarnessId,
  OrclingLook,
  OrclingWakes,
  Reaction,
  type MessageReaction,
  type Orcling,
  type OrclingGroup,
  type OrclingMessageOrigin,
  type OrclingDraft,
  type OrclingInstructionsVersion,
  type OrclingWake,
} from "@openorc/protocol";
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
  wakes: string;
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

function parseWakes(text: string): OrclingWake[] {
  try {
    return OrclingWakes.parse(JSON.parse(text));
  } catch {
    return [];
  }
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
  wakes: parseWakes(row.wakes),
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
  setWakes(db: Db, id: string, wakes: OrclingWake[], now = Date.now()): Orcling | null {
    db.stmt("UPDATE orclings SET wakes = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(wakes), now, id);
    return orclings.get(db, id);
  },
  /** How far each of an Orcling's wake rules has been checked, by rule key. */
  wakeState(db: Db, id: string): Map<string, number> {
    const rows = db.stmt("SELECT rule_key, checked_until FROM orcling_wake_state WHERE orcling_id = ?").all(id) as { rule_key: string; checked_until: number }[];
    return new Map(rows.map((row) => [row.rule_key, row.checked_until]));
  },
  /** Keeps state for exactly these rules; a rule new to the list starts checked until the time given for it. */
  syncWakeState(db: Db, id: string, initial: ReadonlyMap<string, number>): void {
    db.transaction(() => {
      for (const key of orclings.wakeState(db, id).keys()) if (!initial.has(key)) db.stmt("DELETE FROM orcling_wake_state WHERE orcling_id = ? AND rule_key = ?").run(id, key);
      for (const [key, until] of initial) db.stmt("INSERT OR IGNORE INTO orcling_wake_state (orcling_id, rule_key, checked_until) VALUES (?, ?, ?)").run(id, key, until);
    });
  },
  markWakeChecked(db: Db, id: string, key: string, until: number): void {
    db.stmt("INSERT INTO orcling_wake_state (orcling_id, rule_key, checked_until) VALUES (?, ?, ?) ON CONFLICT(orcling_id, rule_key) DO UPDATE SET checked_until = excluded.checked_until").run(
      id,
      key,
      until,
    );
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

interface ReactionRow {
  run_id: string;
  message_id: string;
  part: number;
  reactor: string;
  reaction: string;
  created_at: number;
}

/** The person reacts as this reactor; an Orcling as its own id. */
const PERSON = "person";

const toReaction = (row: ReactionRow): MessageReaction | null => {
  const reaction = Reaction.safeParse(row.reaction);
  if (!reaction.success) return null;
  return { runId: row.run_id, messageId: row.message_id, part: row.part, orclingId: row.reactor === PERSON ? null : row.reactor, reaction: reaction.data, at: row.created_at };
};

export interface ReactionTarget {
  threadId: string;
  runId: string;
  messageId: string;
  part: number;
}

export const messageReactions = {
  list(db: Db, threadId: string): MessageReaction[] {
    const rows = db.stmt("SELECT run_id, message_id, part, reactor, reaction, created_at FROM message_reactions WHERE thread_id = ? ORDER BY created_at").all(threadId) as unknown as ReactionRow[];
    return rows.map(toReaction).filter((reaction) => reaction !== null);
  },
  /** One reaction per reactor on a bubble: a new one replaces the old, null takes it back. */
  set(db: Db, target: ReactionTarget, orclingId: string | null, reaction: Reaction | null, now = Date.now()): void {
    const reactor = orclingId ?? PERSON;
    if (!reaction) {
      db.stmt("DELETE FROM message_reactions WHERE run_id = ? AND message_id = ? AND part = ? AND reactor = ?").run(target.runId, target.messageId, target.part, reactor);
      return;
    }
    db.stmt(
      "INSERT INTO message_reactions (thread_id, run_id, message_id, part, reactor, reaction, heard_at, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?) ON CONFLICT(run_id, message_id, part, reactor) DO UPDATE SET reaction = excluded.reaction, heard_at = NULL, created_at = excluded.created_at",
    ).run(target.threadId, target.runId, target.messageId, target.part, reactor, reaction, now);
  },
  /** The person's reactions the Orcling has not heard yet, oldest first, marked heard as they are taken. */
  takeUnheard(db: Db, threadId: string, now = Date.now()): MessageReaction[] {
    return db.transaction(() => {
      const rows = db
        .stmt("SELECT run_id, message_id, part, reactor, reaction, created_at FROM message_reactions WHERE thread_id = ? AND reactor = ? AND heard_at IS NULL ORDER BY created_at")
        .all(threadId, PERSON) as unknown as ReactionRow[];
      db.stmt("UPDATE message_reactions SET heard_at = ? WHERE thread_id = ? AND reactor = ? AND heard_at IS NULL").run(now, threadId, PERSON);
      return rows.map(toReaction).filter((reaction) => reaction !== null);
    });
  },
};

interface GroupRow {
  thread_id: string;
  title: string;
  created_at: number;
}

export const orclingGroups = {
  /** Makes a conversation a group of these Orclings, in this order. */
  create(db: Db, threadId: string, memberIds: readonly string[], createdBy: string | null, now = Date.now()): void {
    db.transaction(() => {
      db.stmt("INSERT INTO orcling_groups (thread_id, created_by, created_at) VALUES (?, ?, ?)").run(threadId, createdBy, now);
      memberIds.forEach((orclingId, position) => db.stmt("INSERT INTO orcling_group_members (thread_id, orcling_id, position) VALUES (?, ?, ?)").run(threadId, orclingId, position));
    });
  },
  get(db: Db, threadId: string): OrclingGroup | null {
    const row = db.stmt("SELECT g.thread_id, t.title, g.created_at FROM orcling_groups g JOIN threads t ON t.id = g.thread_id WHERE g.thread_id = ?").get(threadId) as unknown as GroupRow | undefined;
    return row ? toGroup(db, row) : null;
  },
  list(db: Db): OrclingGroup[] {
    const rows = db.stmt("SELECT g.thread_id, t.title, g.created_at FROM orcling_groups g JOIN threads t ON t.id = g.thread_id ORDER BY g.created_at, g.thread_id").all() as unknown as GroupRow[];
    return rows.map((row) => toGroup(db, row));
  },
  /** The groups an Orcling is in. */
  of(db: Db, orclingId: string): OrclingGroup[] {
    return orclingGroups.list(db).filter((group) => group.memberIds.includes(orclingId));
  },
};

function toGroup(db: Db, row: GroupRow): OrclingGroup {
  const members = db.stmt("SELECT orcling_id FROM orcling_group_members WHERE thread_id = ? ORDER BY position").all(row.thread_id) as { orcling_id: string }[];
  return { threadId: row.thread_id, title: row.title, memberIds: members.map((member) => member.orcling_id), createdAt: row.created_at };
}

export const orclingMessages = {
  record(db: Db, origin: OrclingMessageOrigin & { threadId: string }, now = Date.now()): void {
    db.stmt("INSERT OR REPLACE INTO orcling_messages (message_id, thread_id, from_orcling_id, to_orcling_id, created_at) VALUES (?, ?, ?, ?, ?)").run(
      origin.messageId,
      origin.threadId,
      origin.fromOrclingId,
      origin.toOrclingId,
      now,
    );
  },
  list(db: Db, threadId: string): OrclingMessageOrigin[] {
    const rows = db.stmt("SELECT message_id, from_orcling_id, to_orcling_id FROM orcling_messages WHERE thread_id = ? ORDER BY created_at").all(threadId) as {
      message_id: string;
      from_orcling_id: string;
      to_orcling_id: string | null;
    }[];
    return rows.map((row) => ({ messageId: row.message_id, fromOrclingId: row.from_orcling_id, toOrclingId: row.to_orcling_id }));
  },
};
