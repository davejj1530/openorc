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
