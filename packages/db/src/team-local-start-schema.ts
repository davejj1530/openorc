import type { DatabaseSync } from "node:sqlite";

/** Initial local teams own a workspace snapshot instead of a previous move. */
export function teamLocalStartMigration(raw: DatabaseSync): void {
  const table = raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='team_moves'").get() as { sql: string };
  const dependents = raw
    .prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND (tbl_name='team_moves' OR (type='trigger' AND instr(sql,'team_moves')>0)) AND type IN ('trigger','index')")
    .all() as { type: string; name: string; sql: string }[];
  const columns = (raw.prepare("PRAGMA table_info(team_moves)").all() as { name: string }[]).map((column) => `"${column.name}"`).join(",");
  // Rebuild the CHECK constraint transactionally, preserving row order and all
  // external guards (including deletion fences) before normal writes resume.
  raw.exec("CREATE TEMP TABLE team_moves_local_backup AS SELECT rowid AS retained_rowid,* FROM team_moves");
  for (const item of dependents.filter((item) => item.type === "trigger")) raw.exec(`DROP TRIGGER "${item.name}"`);
  raw.exec("DROP TABLE team_moves");
  raw.exec(table.sql.replace("json_type(captured_input,'$.originMoveId') IS 'text'", "json_type(captured_input,'$.originMoveId') IN ('text','null')"));
  raw.exec(`INSERT INTO team_moves(rowid,${columns}) SELECT * FROM team_moves_local_backup ORDER BY retained_rowid`);
  raw.exec("DROP TABLE team_moves_local_backup");
  for (const item of dependents) {
    if (item.name !== "team_move_owner") {
      raw.exec(item.sql);
      continue;
    }
    raw.exec(
      item.sql.replace(
        "OR (json_extract(NEW.captured_input,'$.from')='current' AND NOT EXISTS (",
        `OR (json_extract(NEW.captured_input,'$.from')='current' AND NOT (
        json_type(NEW.captured_input,'$.originMoveId') IS 'null'
        AND NOT EXISTS (SELECT 1 FROM team_moves m WHERE m.thread_id=NEW.thread_id AND m.state='applied')
        AND EXISTS (
          SELECT 1 FROM team_workspaces w JOIN team_executions e ON e.id=w.execution_id
          WHERE e.instance_id=NEW.instance_id AND e.thread_id=NEW.thread_id AND e.project_id=NEW.project_id
            AND w.actor_id='lead' AND json_extract(w.payload,'$.path')=json_extract(NEW.captured_input,'$.projectRoot')
            AND json_extract(w.payload,'$.state')='ready' AND json_extract(w.payload,'$.setupState')='completed'
            AND json_type(w.payload,'$.preparedTree') IS 'text'
        )
      ) AND NOT EXISTS (`,
      ),
    );
  }
}
