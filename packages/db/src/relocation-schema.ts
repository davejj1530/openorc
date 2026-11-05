import type { DatabaseSync } from "node:sqlite";

/**
 * Each ledger's journal of its part in moving threads between the Mac and the cloud brain. A row is written only by the
 * host whose ledger holds it; the relocation id is the Mac's and joins the two journals. No FK to threads: the thread
 * may be on the other brain. One relocation at a time per thread on each host.
 */
export const relocationMigration = `
CREATE TABLE IF NOT EXISTS thread_relocations (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('coordinator', 'brain')),
  direction TEXT NOT NULL CHECK (direction IN ('to-cloud', 'to-mac')),
  phase TEXT NOT NULL CHECK (
    (role = 'coordinator' AND direction = 'to-cloud' AND phase IN ('frozen', 'sending', 'done', 'abandoned')) OR
    (role = 'coordinator' AND direction = 'to-mac' AND phase IN ('asking', 'received', 'done', 'abandoned')) OR
    (role = 'brain' AND direction = 'to-cloud' AND phase IN ('arrived', 'dropped')) OR
    (role = 'brain' AND direction = 'to-mac' AND phase IN ('leaving', 'left', 'stayed'))
  ),
  project_id TEXT,
  error TEXT,
  -- What the source still has to clean once it let its copy go (its worktree, its sandbox), until it has.
  cleanup TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS thread_relocations_open ON thread_relocations(thread_id) WHERE phase IN ('frozen', 'sending', 'asking', 'received', 'leaving');
`;

/**
 * Where a move under way stands, for its card: the phase alone does not say whether the brain is still waking. Added only
 * where missing, as the journal's own table is made only where missing.
 */
function relocationStepMigration(raw: DatabaseSync): void {
  const columns = raw.prepare("PRAGMA table_info(thread_relocations)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "step")) raw.exec("ALTER TABLE thread_relocations ADD COLUMN step TEXT");
}

/** The journal's migrations, in order. */
export const relocationMigrations = [relocationMigration, relocationStepMigration];
