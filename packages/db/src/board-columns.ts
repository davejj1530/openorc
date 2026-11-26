import { randomUUID } from "node:crypto";
import type { BoardColumn, BoardStage } from "@openorc/protocol";
import type { Db } from "./database.js";

interface BoardColumnRow {
  id: string;
  project_id: string;
  name: string;
  stage: BoardStage;
  job_button_id: string | null;
  next_column_id: string | null;
  job_enabled: number;
}
/** A column as a board is saved with it. One without an id, or with an id the project does not keep, is new. */
export type BoardColumnInput = { id?: string; name: string; stage: BoardStage; jobButtonId?: string | null; nextColumnId?: string | null; jobEnabled?: boolean };

const FIELDS = "id, project_id, name, stage, job_button_id, next_column_id, job_enabled";
const fromRow = (row: BoardColumnRow): BoardColumn => ({
  id: row.id,
  projectId: row.project_id,
  name: row.name,
  stage: row.stage,
  jobButtonId: row.job_button_id,
  nextColumnId: row.next_column_id,
  jobEnabled: row.job_enabled === 1,
});

export const boardColumns = {
  list(db: Db, projectId: string): BoardColumn[] {
    return (db.stmt(`SELECT ${FIELDS} FROM board_columns WHERE project_id = ? ORDER BY position`).all(projectId) as unknown as BoardColumnRow[]).map(fromRow);
  },
  /** The columns that start a job, of one project or of every project, each project's in its board's order. */
  withJobs(db: Db, projectId?: string): BoardColumn[] {
    const rows = db.stmt(`SELECT ${FIELDS} FROM board_columns WHERE job_button_id IS NOT NULL AND (?1 IS NULL OR project_id = ?1) ORDER BY project_id, position`).all(projectId ?? null);
    return (rows as unknown as BoardColumnRow[]).map(fromRow);
  },
  setJobEnabled(db: Db, id: string, enabled: boolean): void {
    db.stmt("UPDATE board_columns SET job_enabled = ?, updated_at = ? WHERE id = ?").run(Number(enabled), Date.now(), id);
  },
  get(db: Db, id: string): BoardColumn | null {
    const row = db.stmt(`SELECT ${FIELDS} FROM board_columns WHERE id = ?`).get(id) as unknown as BoardColumnRow | undefined;
    return row ? fromRow(row) : null;
  },
  /**
   * Makes the project's board exactly these columns, in this order. A kept column that changes stage takes its tasks
   * with it; one left out is removed, and its tasks stay in their status. A column hands its cards on only to a column
   * after it, so no chain of jobs comes back round.
   */
  save(db: Db, projectId: string, columns: readonly BoardColumnInput[]): BoardColumn[] {
    return db.transaction(() => {
      const ts = Date.now();
      const kept = new Map(boardColumns.list(db, projectId).map((column) => [column.id, column]));
      const ids = columns.map((column) => (column.id && kept.has(column.id) ? column.id : randomUUID()));
      for (const id of kept.keys()) if (!ids.includes(id)) db.stmt("DELETE FROM board_columns WHERE id = ?").run(id);
      columns.forEach((column, position) => {
        const id = ids[position]!;
        const before = kept.get(id);
        const job = column.jobButtonId ?? null;
        const enabled = Number(column.jobEnabled ?? true);
        if (!before) {
          db.stmt("INSERT INTO board_columns (id, project_id, name, stage, position, job_button_id, job_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
            id,
            projectId,
            column.name,
            column.stage,
            position,
            job,
            enabled,
            ts,
            ts,
          );
          return;
        }
        db.stmt("UPDATE board_columns SET name = ?, stage = ?, position = ?, job_button_id = ?, job_enabled = ?, next_column_id = NULL, updated_at = ? WHERE id = ?").run(
          column.name,
          column.stage,
          position,
          job,
          enabled,
          ts,
          id,
        );
        if (before.stage !== column.stage) {
          db.stmt("UPDATE tasks SET status = ?, status_is_explicit = 1, completed_at = ?, updated_at = ? WHERE column_id = ?").run(column.stage, column.stage === "done" ? ts : null, ts, id);
        }
      });
      // Set once every column is in place, since a column names another one.
      columns.forEach((column, position) => {
        const next = column.nextColumnId ? ids.indexOf(column.nextColumnId) : -1;
        if (next > position) db.stmt("UPDATE board_columns SET next_column_id = ? WHERE id = ?").run(ids[next]!, ids[position]!);
      });
      return boardColumns.list(db, projectId);
    });
  },
};
