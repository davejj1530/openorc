import type { DatabaseSync } from "node:sqlite";

/** Cancellation preserves the original receipt and every candidate path for inspection. */
export function teamCancellationMigration(raw: DatabaseSync): void {
  for (const table of ["team_forks", "team_restores", "team_deletions"]) {
    raw.exec(`ALTER TABLE ${table} ADD COLUMN cancelled_at INTEGER CHECK(cancelled_at IS NULL OR cancelled_at>=created_at);
      CREATE TRIGGER ${table}_cancel_terminal BEFORE UPDATE ON ${table}
      WHEN OLD.cancelled_at IS NOT NULL OR (NEW.cancelled_at IS NOT NULL AND NEW.state='applied')
      BEGIN SELECT RAISE(ABORT,'A cancelled operation cannot apply or change; an applied operation cannot be cancelled.'); END;`);
  }
  // Keep all existing ownership and history guards; cancelled deletes no longer fence new work.
  const triggers = raw.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND sql LIKE '%team_deletions%'").all() as { name: string; sql: string }[];
  for (const trigger of triggers) {
    const sql = trigger.sql
      .replaceAll("d.state<>'applied'", "d.state<>'applied' AND d.cancelled_at IS NULL")
      .replaceAll("d.state='applied'", "(d.state='applied' OR d.cancelled_at IS NOT NULL)")
      .replaceAll("WHERE json_extract(o.value", "WHERE d.cancelled_at IS NULL AND json_extract(o.value");
    if (sql === trigger.sql) continue;
    raw.exec(`DROP TRIGGER "${trigger.name}"; ${sql}`);
  }
  raw.exec(`DROP INDEX team_deletions_one_open_per_thread;
    CREATE UNIQUE INDEX team_deletions_one_open_per_thread ON team_deletions(thread_id) WHERE state<>'applied' AND cancelled_at IS NULL;`);
}
