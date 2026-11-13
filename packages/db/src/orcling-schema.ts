/**
 * Orclings: saved identities with their own look, model, permission,
 * instructions and memory. Each one has a personal conversation; threads and
 * runs remember which Orcling spoke, so its identity follows it into project
 * threads, reviews, task comments and teams. Instructions keep every version,
 * newest last, and its memories live beside project memories without a
 * project. A saved team revision records which seats Orclings took: the
 * member runs on its Orcling's own model, and its identity joins its turns.
 */
export const orclingMigration = `
CREATE TABLE orclings (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL,
 look TEXT NOT NULL,
 agent TEXT NOT NULL,
 model TEXT NOT NULL,
 effort TEXT,
 fast_mode INTEGER NOT NULL DEFAULT 0,
 permission TEXT NOT NULL CHECK(permission IN ('allow', 'approve')),
 thread_id TEXT NOT NULL REFERENCES threads(id),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX orclings_thread ON orclings(thread_id);
CREATE TABLE orcling_instructions (
 orcling_id TEXT NOT NULL REFERENCES orclings(id) ON DELETE CASCADE,
 version INTEGER NOT NULL CHECK(version > 0),
 body TEXT NOT NULL,
 author TEXT NOT NULL CHECK(author IN ('user', 'orcling')),
 note TEXT,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(orcling_id, version)
);
ALTER TABLE threads ADD COLUMN orcling_id TEXT REFERENCES orclings(id) ON DELETE SET NULL;
ALTER TABLE runs ADD COLUMN orcling_id TEXT REFERENCES orclings(id) ON DELETE SET NULL;
ALTER TABLE memories ADD COLUMN orcling_id TEXT REFERENCES orclings(id) ON DELETE CASCADE;
CREATE INDEX memories_orcling ON memories(orcling_id, status, type) WHERE orcling_id IS NOT NULL;
CREATE UNIQUE INDEX memories_orcling_topic ON memories(orcling_id, topic_key) WHERE orcling_id IS NOT NULL AND topic_key IS NOT NULL AND status = 'active';
CREATE INDEX runs_orcling ON runs(orcling_id, thread_id) WHERE orcling_id IS NOT NULL;
ALTER TABLE orchestration_team_revisions ADD COLUMN orcling_seats TEXT;
`;

/** The Claude account an Orcling runs on, wherever it works. Each starts on its own conversation's. */
export const orclingAccountMigration = `
ALTER TABLE orclings ADD COLUMN claude_account_id TEXT REFERENCES claude_accounts(id);
UPDATE orclings SET claude_account_id = (SELECT claude_account_id FROM threads WHERE threads.id = orclings.thread_id);
`;

/**
 * An Orcling's life between your messages. Wakes are its rules for checking in on its own, and each rule's state is how
 * far it has been checked, so a rule fires once for its latest missed time and never for times before it existed.
 * Reactions are tapbacks on one bubble of a message: the person's on the Orcling's, or the Orcling's on the person's.
 * A person's reaction is heard by the Orcling once, on its next turn.
 */
export const orclingCompanionMigration = `
ALTER TABLE orclings ADD COLUMN wakes TEXT NOT NULL DEFAULT '[]';
CREATE TABLE orcling_wake_state (
 orcling_id TEXT NOT NULL REFERENCES orclings(id) ON DELETE CASCADE,
 rule_key TEXT NOT NULL,
 checked_until INTEGER NOT NULL,
 PRIMARY KEY(orcling_id, rule_key)
);
CREATE TABLE message_reactions (
 thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
 run_id TEXT NOT NULL,
 message_id TEXT NOT NULL,
 part INTEGER NOT NULL CHECK(part >= 0),
 reactor TEXT NOT NULL,
 reaction TEXT NOT NULL CHECK(reaction IN ('heart', 'like', 'dislike', 'haha', 'wow', 'sad')),
 heard_at INTEGER,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(run_id, message_id, part, reactor)
);
CREATE INDEX message_reactions_thread ON message_reactions(thread_id, created_at);
`;

/**
 * Orclings talking to each other. A group is a Workspace conversation shared by the person and several Orclings, its
 * members in the order they answer a message that names none of them. An Orcling's message into another conversation,
 * a direct message into another Orcling's own chat or the words that open a group, remembers who sent it.
 */
export const orclingTalkMigration = `
CREATE TABLE orcling_groups (
 thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
 created_by TEXT REFERENCES orclings(id) ON DELETE SET NULL,
 created_at INTEGER NOT NULL
);
CREATE TABLE orcling_group_members (
 thread_id TEXT NOT NULL REFERENCES orcling_groups(thread_id) ON DELETE CASCADE,
 orcling_id TEXT NOT NULL REFERENCES orclings(id) ON DELETE CASCADE,
 position INTEGER NOT NULL,
 PRIMARY KEY(thread_id, orcling_id)
);
CREATE INDEX orcling_group_members_orcling ON orcling_group_members(orcling_id);
CREATE TABLE orcling_messages (
 message_id TEXT PRIMARY KEY,
 thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
 from_orcling_id TEXT NOT NULL REFERENCES orclings(id) ON DELETE CASCADE,
 to_orcling_id TEXT REFERENCES orclings(id) ON DELETE SET NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX orcling_messages_thread ON orcling_messages(thread_id, created_at);
`;

/** A thread an Orcling asked to hear back from: it is told once, when the thread's turn ends. */
export const orclingFollowupMigration = `
CREATE TABLE orcling_followups (
 thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
 orcling_id TEXT NOT NULL REFERENCES orclings(id) ON DELETE CASCADE,
 created_at INTEGER NOT NULL
);
`;

/**
 * Reactions take any tapback the protocol knows. The table is made again without its list of kinds, since the
 * protocol checks a reaction where it comes in and reading skips a kind it doesn't know.
 */
export const reactionKindsMigration = `
CREATE TABLE message_reactions_next (
 thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
 run_id TEXT NOT NULL,
 message_id TEXT NOT NULL,
 part INTEGER NOT NULL CHECK(part >= 0),
 reactor TEXT NOT NULL,
 reaction TEXT NOT NULL,
 heard_at INTEGER,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(run_id, message_id, part, reactor)
);
INSERT INTO message_reactions_next (thread_id, run_id, message_id, part, reactor, reaction, heard_at, created_at)
  SELECT thread_id, run_id, message_id, part, reactor, reaction, heard_at, created_at FROM message_reactions;
DROP TABLE message_reactions;
ALTER TABLE message_reactions_next RENAME TO message_reactions;
CREATE INDEX message_reactions_thread ON message_reactions(thread_id, created_at);
`;
