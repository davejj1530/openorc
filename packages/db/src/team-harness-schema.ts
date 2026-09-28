import type { DatabaseSync } from "node:sqlite";

/** Expand the shipped team allowlist without changing pinned rosters or their guards. */
export function teamHarnessMigration(raw: DatabaseSync): void {
  const table = raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='orchestration_team_members'").get() as { sql: string };
  const previous = "CHECK(agent IN ('codex', 'claude'))";
  if (!table.sql.includes(previous)) throw new Error("The team member harness constraint was not found.");
  const dependents = raw
    .prepare(
      "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND (tbl_name='orchestration_team_members' OR (type='trigger' AND instr(sql,'orchestration_team_members')>0)) AND type IN ('trigger','index')",
    )
    .all() as { type: string; name: string; sql: string }[];
  const columns = (raw.prepare("PRAGMA table_info(orchestration_team_members)").all() as { name: string }[]).map((column) => `"${column.name}"`).join(",");
  // Db.migrate supplies the transaction and foreign-key check. Keep the original
  // table name so incoming references and the self-referencing hierarchy survive.
  raw.exec("CREATE TEMP TABLE team_harness_backup AS SELECT rowid AS retained_rowid,* FROM orchestration_team_members");
  for (const item of dependents.filter((item) => item.type === "trigger")) raw.exec(`DROP TRIGGER "${item.name}"`);
  raw.exec("DROP TABLE orchestration_team_members");
  raw.exec(table.sql.replace(previous, "CHECK(agent IN ('codex', 'claude', 'opencode'))"));
  raw.exec(`INSERT INTO orchestration_team_members(rowid,${columns}) SELECT * FROM team_harness_backup ORDER BY retained_rowid`);
  raw.exec("DROP TABLE team_harness_backup");
  for (const item of dependents) raw.exec(item.sql);
}
