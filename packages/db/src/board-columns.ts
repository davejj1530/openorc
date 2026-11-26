import { randomUUID } from "node:crypto";
import type { BoardColumn, BoardStage } from "@openorc/protocol";
import type { Db } from "./database.js";

interface BoardColumnRow {
  id: string;
  project_id: string;
  name: string;
  stage: BoardStage;
}

const fromRow = (row: BoardColumnRow): BoardColumn => ({ id: row.id, projectId: row.project_id, name: row.name, stage: row.stage });

export const boardColumns = {
  list(db: Db, projectId: string): BoardColumn[] {
    return (db.stmt("SELECT id, project_id, name, stage FROM board_columns WHERE project_id = ? ORDER BY position").all(projectId) as unknown as BoardColumnRow[]).map(fromRow);
  },
  get(db: Db, id: string): BoardColumn | null {
    const row = db.stmt("SELECT id, project_id, name, stage FROM board_columns WHERE id = ?").get(id) as unknown as BoardColumnRow | undefined;
    return row ? fromRow(row) : null;
  },
  /**
   * Makes the project's board exactly these columns, in this order. A kept column that changes stage takes its tasks
   * with it; one left out is removed, and its tasks stay in their status.
   */
  save(db: Db, projectId: string, columns: readonly { id?: string; name: string; stage: BoardStage }[]): BoardColumn[] {
    return db.transaction(() => {
      const ts = Date.now();
      const kept = new Map(boardColumns.list(db, projectId).map((column) => [column.id, column]));
      const ids = columns.map((column) => (column.id && kept.has(column.id) ? column.id : randomUUID()));
      for (const id of kept.keys()) if (!ids.includes(id)) db.stmt("DELETE FROM board_columns WHERE id = ?").run(id);
      columns.forEach((column, position) => {
        const id = ids[position]!;
        const before = kept.get(id);
        if (!before) {
          db.stmt("INSERT INTO board_columns (id, project_id, name, stage, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
            id,
            projectId,
            column.name,
            column.stage,
            position,
            ts,
            ts,
          );
          return;
        }
        db.stmt("UPDATE board_columns SET name = ?, stage = ?, position = ?, updated_at = ? WHERE id = ?").run(column.name, column.stage, position, ts, id);
        if (before.stage !== column.stage) {
          db.stmt("UPDATE tasks SET status = ?, status_is_explicit = 1, completed_at = ?, updated_at = ? WHERE column_id = ?").run(column.stage, column.stage === "done" ? ts : null, ts, id);
        }
      });
      return boardColumns.list(db, projectId);
    });
  },
};
