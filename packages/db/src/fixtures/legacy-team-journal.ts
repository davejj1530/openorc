import { TeamExecutionRecord } from "@openorc/protocol";
import { vi } from "vitest";
import type { Db } from "../database.js";
import { teamRuntime } from "../team-runtime.js";

/** The turn input every legacy fixture turn carried in its journal; migration moves it beside the journal. */
export const LEGACY_TEAM_PROMPT = "Legacy turn input";

/** What the current reader returns for a stored legacy journal: turn prompts live apart and no claims means none. */
function current(payload: string): TeamExecutionRecord {
  const record = TeamExecutionRecord.parse(JSON.parse(payload));
  if (!record.claims?.length) delete record.claims;
  return record;
}

function bind(db: Db, record: TeamExecutionRecord): void {
  for (const actor of record.actors)
    if (actor.taskId !== null) db.stmt("INSERT OR IGNORE INTO team_assignment_bindings (task_id, execution_id, actor_id) VALUES (?, ?, ?)").run(actor.taskId, record.id, actor.id);
  const owners = new Set<string>();
  for (const attempt of record.attempts)
    if (attempt.runId !== null && !owners.has(attempt.runId)) {
      owners.add(attempt.runId);
      db.stmt("INSERT OR IGNORE INTO team_run_bindings (run_id, execution_id, actor_id, attempt_id, generation) VALUES (?, ?, ?, ?, ?)").run(
        attempt.runId,
        record.id,
        attempt.actorId,
        attempt.id,
        attempt.generation,
      );
    }
}

function payload(record: TeamExecutionRecord): string {
  return JSON.stringify({ ...record, attempts: record.attempts.map((attempt) => ({ ...attempt, prompt: LEGACY_TEAM_PROMPT })) });
}

/**
 * Writes team executions the way ledgers before version 40 stored them: the whole journal as one JSON document, each
 * turn carrying its prompt, with task and run bindings beside it. Keep this frozen, like insertLegacyRun, so
 * historical fixtures build real old ledgers for the migrations under test. It checks nothing; fixtures supply
 * journals the old writer accepted.
 */
export const legacyTeamRuntime = {
  create(db: Db, input: TeamExecutionRecord): TeamExecutionRecord {
    const record = current(JSON.stringify(input));
    db.stmt("INSERT INTO team_executions (id, instance_id, thread_id, project_id, state, generation, revision, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      record.id,
      record.instanceId,
      record.threadId,
      record.projectId,
      record.state,
      record.generation,
      record.revision,
      payload(record),
      record.createdAt,
      record.updatedAt,
    );
    bind(db, record);
    return record;
  },
  get(db: Db, id: string): TeamExecutionRecord | null {
    const row = db.stmt("SELECT payload FROM team_executions WHERE id = ?").get(id) as { payload: string } | undefined;
    return row ? current(row.payload) : null;
  },
  update<T>(db: Db, id: string, mutate: (record: TeamExecutionRecord) => T): { record: TeamExecutionRecord; value: T } {
    const draft = legacyTeamRuntime.get(db, id)!;
    const revision = draft.revision;
    const value = mutate(draft);
    const record = current(JSON.stringify({ ...draft, revision: revision + 1, updatedAt: Math.max(Date.now(), draft.updatedAt) }));
    db.stmt("UPDATE team_executions SET state = ?, generation = ?, revision = ?, payload = ?, updated_at = ? WHERE id = ?").run(
      record.state,
      record.generation,
      record.revision,
      payload(record),
      record.updatedAt,
      id,
    );
    bind(db, record);
    return { record, value };
  },
};

/** The journal writer a ledger's schema expects: the legacy document before version 40, rows after. */
export function teamJournalWriter(db: Db): Pick<typeof teamRuntime, "create" | "get" | "update"> {
  const legacy = (db.stmt("SELECT 1 FROM pragma_table_info('team_executions') WHERE name = 'payload'").get() as unknown) !== undefined;
  return legacy ? legacyTeamRuntime : teamRuntime;
}

/**
 * While a test builds an old ledger, current writers that check a journal (workspace and task receipts) read it the
 * way that ledger stores it. Returns the restore function; call it before migrating.
 */
export function readLegacyJournals(): () => void {
  const read = teamRuntime.get;
  const spy = vi.spyOn(teamRuntime, "get").mockImplementation((db, id) => (teamJournalWriter(db) === legacyTeamRuntime ? legacyTeamRuntime.get(db, id) : read(db, id)));
  return () => spy.mockRestore();
}
