import { createHash } from "node:crypto";
import type { Db } from "./database.js";

/**
 * Every table holding a thread's own rows, in write order: what another ledger needs to continue the thread. A guard test
 * fails unless every table that references a thread, run or event is here or in HOST_TABLES, so a new one cannot be left
 * out of a relocation.
 */
export const THREAD_TABLES = [
  "threads",
  "tasks",
  "task_comments",
  "task_comment_attempts",
  "runs",
  "events",
  "artifacts",
  "thread_messages",
  "thread_queue",
  "thread_checkpoints",
  "conversation_plans",
  "conversation_plan_turns",
  "subagents",
  "snapshots",
  "review_comments",
  "session_summaries",
] as const;
export type ThreadTable = (typeof THREAD_TABLES)[number];

/** Tables that reference a thread or run but stay with their host, and why. */
export const HOST_TABLES: Record<string, string> = {
  cloud_workspaces: "the target makes its own sandbox record",
  thread_relocations: "each host keeps its own journal",
  messages_fts: "rebuilt on the target from the package's search rows",
  usage_reports: "rebuilt by ledger triggers from the imported events and artifacts",
  memories: "memory merges by its own rules",
  extraction_jobs: "memory work belongs to the host that ran it",
  orclings: "an Orcling's conversation is refused",
  schedules: "a schedule stays with the host that runs it",
  schedule_firings: "as schedules",
  pull_request_reviews: "a review stays with the Mac's pull request copy",
  orchestration_team_instances: "Teams are retired; a thread with team records is refused",
};
/** Retired Teams tables, all host-bound by the same rule. */
export const HOST_TABLE_PREFIXES: Record<string, string> = { team_: "Teams are retired; a thread with team records is refused" };

/** Tables that reference a thread, run or event, by foreign key or by a column's name, and are in neither list. */
export function unclassifiedTables(db: Db): string[] {
  const tables = (db.stmt("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((row) => row.name);
  return tables.filter((table) => {
    const keys = (db.stmt(`PRAGMA foreign_key_list("${table}")`).all() as { table: string }[]).filter((fk) => ["threads", "runs", "events"].includes(fk.table));
    const named = (db.stmt(`PRAGMA table_info("${table}")`).all() as { name: string }[]).filter((column) => /(^|_)(thread|run|event)_id$/.test(column.name));
    if (!keys.length && !named.length) return false;
    return !(THREAD_TABLES as readonly string[]).includes(table) && !Object.hasOwn(HOST_TABLES, table) && !Object.keys(HOST_TABLE_PREFIXES).some((prefix) => table.startsWith(prefix));
  });
}

type Row = Record<string, unknown>;
type SearchRow = { text: string; run_id: string; role: string; ts: number; message_id: string };

/** A thread's own rows as read, opaque to everything but writeThreadRows. */
export interface ThreadRows {
  v: 1;
  threadId: string;
  tables: Record<ThreadTable, Row[]>;
  search: SearchRow[];
}

/** Where the target puts the thread: its project, its worktree, and its data folder in place of the source's. */
export interface RowRewrite {
  projectId: string;
  /** Text replaced in every path and payload: the source's worktree and data folder become the target's. */
  paths: { from: string; to: string }[];
}

const marks = (values: readonly unknown[]) => values.map(() => "?").join(", ");

function select(db: Db, table: string, column: string, values: readonly unknown[]): Row[] {
  if (!values.length) return [];
  return db.stmt(`SELECT * FROM ${table} WHERE ${column} IN (${marks(values)})`).all(...(values as string[])) as Row[];
}

/** The thread and its native subagent children, parents first. */
function family(db: Db, threadId: string): string[] {
  const ids = [threadId];
  for (let index = 0; index < ids.length; index++) {
    const children = db.stmt("SELECT id FROM threads WHERE parent_thread_id = ? AND parent_relation = 'subagent'").all(ids[index]!) as { id: string }[];
    ids.push(...children.map((child) => child.id).filter((id) => !ids.includes(id)));
  }
  return ids;
}

/** Tasks belong to the thread doing their work: their execution thread, else the thread that made them. */
function ownedTaskIds(db: Db, ids: readonly string[]): string[] {
  if (!ids.length) return [];
  return (db.stmt(`SELECT id FROM tasks WHERE COALESCE(execution_thread_id, thread_id) IN (${marks(ids)})`).all(...ids) as { id: string }[]).map((row) => row.id);
}

/** The tasks that move with `threadId`: those it or one of its subagent children owns. */
export function threadTaskIds(db: Db, threadId: string): string[] {
  return ownedTaskIds(db, family(db, threadId));
}

/**
 * What keeps a thread's tasks from moving with it: one of them has runs from outside the thread and its subagents (task
 * runs from before conversations), or a folder of its own; null when nothing does.
 */
export function taskTies(db: Db, threadId: string): "runs" | "folder" | null {
  const ids = family(db, threadId);
  const taskIds = ownedTaskIds(db, ids);
  if (!taskIds.length) return null;
  const outside = db.stmt(`SELECT 1 FROM runs WHERE task_id IN (${marks(taskIds)}) AND (thread_id IS NULL OR thread_id NOT IN (${marks(ids)})) LIMIT 1`).get(...taskIds, ...ids);
  if (outside) return "runs";
  const folder = db
    .stmt(
      `SELECT 1 FROM tasks t WHERE t.id IN (${marks(taskIds)}) AND t.worktree_path IS NOT NULL
         AND t.worktree_path IS NOT (SELECT worktree_path FROM threads WHERE id = COALESCE(t.execution_thread_id, t.thread_id)) LIMIT 1`,
    )
    .get(...taskIds);
  return folder ? "folder" : null;
}

/** The rows of `threadId` and its subagent children, with the tasks they own, read in one transaction. */
export function readThreadRows(db: Db, threadId: string): ThreadRows {
  return db.transaction(() => {
    const ids = family(db, threadId);
    const threads = ids.flatMap((id) => select(db, "threads", "id", [id]));
    if (!threads.length) throw new Error(`Thread ${threadId} not found`);
    const taskIds = ownedTaskIds(db, ids);
    const runs = select(db, "runs", "thread_id", ids);
    const runIds = runs.map((run) => run.id);
    const events = runIds.length ? (db.stmt(`SELECT * FROM events WHERE run_id IN (${marks(runIds)}) ORDER BY id`).all(...(runIds as string[])) as Row[]) : [];
    const tables: Record<ThreadTable, Row[]> = {
      threads,
      tasks: select(db, "tasks", "id", taskIds),
      task_comments: select(db, "task_comments", "task_id", taskIds),
      task_comment_attempts: select(db, "task_comment_attempts", "task_id", taskIds),
      snapshots: select(db, "snapshots", "task_id", taskIds),
      runs,
      events,
      artifacts: select(
        db,
        "artifacts",
        "event_id",
        events.map((event) => event.id),
      ),
      thread_messages: select(db, "thread_messages", "thread_id", ids),
      thread_queue: select(db, "thread_queue", "thread_id", ids),
      thread_checkpoints: select(db, "thread_checkpoints", "thread_id", ids),
      conversation_plans: select(db, "conversation_plans", "thread_id", ids),
      conversation_plan_turns: select(db, "conversation_plan_turns", "run_id", runIds),
      subagents: select(db, "subagents", "thread_id", ids),
      // A task's own review comments too, which deleting the task would take with it.
      review_comments: taskIds.length
        ? (db.stmt(`SELECT * FROM review_comments WHERE thread_id IN (${marks(ids)}) OR task_id IN (${marks(taskIds)})`).all(...ids, ...taskIds) as Row[])
        : select(db, "review_comments", "thread_id", ids),
      session_summaries: select(db, "session_summaries", "thread_id", ids),
    };
    const search = runIds.length ? (db.stmt(`SELECT text, run_id, role, ts, message_id FROM messages_fts WHERE run_id IN (${marks(runIds)})`).all(...(runIds as string[])) as SearchRow[]) : [];
    return { v: 1, threadId, tables, search };
  });
}

function rewriteText(value: unknown, rewrite: RowRewrite): unknown {
  if (typeof value !== "string") return value;
  return rewrite.paths.reduce((text, { from, to }) => (from && from !== to ? text.split(from).join(to) : text), value);
}

/** Columns that hold paths or payloads naming them. */
const PATH_COLUMNS: Partial<Record<ThreadTable, string[]>> = {
  threads: ["worktree_path", "working_directory"],
  tasks: ["worktree_path"],
  runs: ["working_directory"],
  events: ["payload"],
  artifacts: ["content"],
  thread_messages: ["attachments"],
  thread_queue: ["attachments"],
  thread_checkpoints: ["root"],
};

type Kept = Record<"threads" | "runs" | "tasks" | "attempts" | "snapshots", Set<unknown>>;

/** References another ledger cannot satisfy, cleared on write: whatever names a row that did not travel. */
function crossHost(table: ThreadTable, row: Row, kept: Kept): Row {
  const clear = (...columns: string[]) => Object.fromEntries(columns.filter((column) => column in row).map((column) => [column, null]));
  const unless = (rows: Set<unknown>, column: string, ...also: string[]) => (row[column] === null || rows.has(row[column]) ? {} : clear(column, ...also));
  switch (table) {
    case "threads":
      return {
        ...clear("orcling_id"),
        ...(kept.threads.has(row.forked_from_id) ? {} : clear("forked_from_id", "forked_at_run_id")),
        ...(kept.threads.has(row.parent_thread_id) ? {} : clear("parent_thread_id", "parent_relation")),
      };
    case "tasks":
      // Its parent and snapshots may come later; writeThreadRows links them once every row is in.
      return { ...clear("reviewed_snapshot_id", "parent_task_id"), ...unless(kept.threads, "thread_id") };
    case "runs":
      return { ...clear("orcling_id"), ...unless(kept.tasks, "task_id"), ...unless(kept.attempts, "comment_turn_id") };
    case "snapshots":
      return unless(kept.runs, "run_id");
    case "review_comments":
      return { ...unless(kept.tasks, "task_id"), ...unless(kept.snapshots, "snapshot_id"), ...unless(kept.runs, "sent_in_run_id") };
    case "session_summaries":
    case "subagents":
      return unless(kept.tasks, "task_id");
    default:
      return {};
  }
}

function insert(db: Db, table: string, row: Row, columns: Set<string>): number {
  const names = Object.keys(row).filter((name) => columns.has(name));
  const result = db.stmt(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${marks(names)})`).run(...(names.map((name) => row[name]) as (string | number | null)[]));
  return Number(result.lastInsertRowid);
}

const tableColumns = (db: Db, table: string) => new Set((db.stmt(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((column) => column.name));

/** The tasks' parents and reviewed snapshots, linked once every row is in, where they travelled too. */
function linkTasks(db: Db, rows: readonly Row[], kept: Kept): void {
  for (const task of rows)
    db.stmt("UPDATE tasks SET parent_task_id = ?, reviewed_snapshot_id = ? WHERE id = ?").run(
      kept.tasks.has(task.parent_task_id) ? (task.parent_task_id as string) : null,
      kept.snapshots.has(task.reviewed_snapshot_id) ? (task.reviewed_snapshot_id as string) : null,
      task.id as string,
    );
}

/**
 * Writes `rows` inside the caller's transaction, unless this ledger already holds the thread, which makes taking the
 * same package twice a no-op. Events get new ids and their artifacts follow them; columns this ledger lacks are left
 * out. True when it wrote.
 */
export function writeThreadRows(db: Db, rows: ThreadRows, rewrite: RowRewrite): boolean {
  if (db.stmt("SELECT 1 FROM threads WHERE id = ?").get(rows.threadId)) return false;
  // A package from a build before tasks moved has no task tables.
  const of = (table: ThreadTable) => rows.tables[table] ?? [];
  const ids = (table: ThreadTable) => new Set(of(table).map((row) => row.id));
  const kept: Kept = { threads: ids("threads"), runs: ids("runs"), tasks: ids("tasks"), attempts: ids("task_comment_attempts"), snapshots: ids("snapshots") };
  const eventIds = new Map<unknown, number>();
  for (const table of THREAD_TABLES) {
    const columns = tableColumns(db, table);
    for (const source of of(table)) {
      const row: Row = { ...source, ...crossHost(table, source, kept) };
      for (const column of PATH_COLUMNS[table] ?? []) row[column] = rewriteText(row[column], rewrite);
      if (table === "threads" || table === "tasks" || table === "session_summaries") row.project_id = rewrite.projectId;
      if (table === "events") {
        const { id, ...event } = row;
        if (event.payload !== source.payload) event.payload_sha256 = createHash("sha256").update(String(event.payload)).digest("hex");
        eventIds.set(id, insert(db, table, event, columns));
        continue;
      }
      if (table === "artifacts") row.event_id = eventIds.get(source.event_id);
      insert(db, table, row, columns);
    }
  }
  linkTasks(db, of("tasks"), kept);
  for (const entry of rows.search)
    db.stmt("INSERT INTO messages_fts (text, run_id, role, ts, message_id) VALUES (?, ?, ?, ?, ?)").run(entry.text, entry.run_id, entry.role, entry.ts, entry.message_id);
  return true;
}

/**
 * Deletes the thread, its subagent children and the tasks they own inside the caller's transaction; foreign keys cascade
 * to their rows. The tasks go first: deleting a thread clears the task links that name it.
 */
export function deleteThreadRows(db: Db, threadId: string): void {
  const ids = family(db, threadId);
  const runIds = (select(db, "runs", "thread_id", ids) as { id: string }[]).map((run) => run.id);
  if (runIds.length) db.stmt(`DELETE FROM messages_fts WHERE run_id IN (${marks(runIds)})`).run(...runIds);
  for (const id of ownedTaskIds(db, ids)) db.stmt("DELETE FROM tasks WHERE id = ?").run(id);
  for (const id of [...ids].reverse()) db.stmt("DELETE FROM threads WHERE id = ?").run(id);
}
