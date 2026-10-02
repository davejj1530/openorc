import { threadListOrder } from "./thread-list-order.js";
import { randomUUID } from "node:crypto";
import { WORKSPACE_ID } from "@openorc/protocol";
import type { Run, RunState, Snapshot, Task, TaskStatus, Thread, Usage } from "@openorc/protocol";
import type { Db } from "./database.js";
import { redact, redactJson } from "./redact.js";
import { jaccard, normalizeTitle, wordSet } from "./task-similarity.js";

const now = () => Date.now();

// Keep the repository exports stable while project persistence and review comments live in their own modules.
export { projects } from "./projects.js";
export { comments, type ReviewCommentScope, type ReviewCommentInsert } from "./review-comments.js";

/* Tasks */

interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  spec: string | null;
  status: TaskStatus;
  priority: Task["priority"];
  labels: string;
  workspace_mode: Task["workspaceMode"];
  base_ref: string | null;
  base_sha: string | null;
  branch: string | null;
  worktree_path: string | null;
  parent_task_id: string | null;
  thread_id: string | null;
  execution_thread_id: string | null;
  origin: Task["origin"];
  reviewed_snapshot_id: string | null;
  cost_usd: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

function taskFromRow(r: TaskRow): Task {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    spec: r.spec,
    status: r.status,
    priority: r.priority,
    labels: JSON.parse(r.labels) as string[],
    workspaceMode: r.workspace_mode,
    baseRef: r.base_ref,
    baseSha: r.base_sha,
    branch: r.branch,
    worktreePath: r.worktree_path,
    parentTaskId: r.parent_task_id,
    threadId: r.thread_id,
    executionThreadId: r.execution_thread_id,
    origin: r.origin,
    reviewedSnapshotId: r.reviewed_snapshot_id,
    costUsd: r.cost_usd,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
  };
}

export interface TaskPatch {
  threadId?: string | null;
  executionThreadId?: string | null;
  workspaceMode?: Task["workspaceMode"];
  title?: string;
  spec?: string | null;
  status?: TaskStatus;
  priority?: Task["priority"];
  labels?: string[];
  baseRef?: string | null;
  baseSha?: string | null;
  branch?: string | null;
  worktreePath?: string | null;
  reviewedSnapshotId?: string | null;
  costUsd?: number;
  completedAt?: number | null;
}

const taskColumns: Record<keyof TaskPatch, string> = {
  threadId: "thread_id",
  executionThreadId: "execution_thread_id",
  workspaceMode: "workspace_mode",
  title: "title",
  spec: "spec",
  status: "status",
  priority: "priority",
  labels: "labels",
  baseRef: "base_ref",
  baseSha: "base_sha",
  branch: "branch",
  worktreePath: "worktree_path",
  reviewedSnapshotId: "reviewed_snapshot_id",
  costUsd: "cost_usd",
  completedAt: "completed_at",
};

export const tasks = {
  list(db: Db, filter: { projectId?: string; threadId?: string; statuses?: TaskStatus[] } = {}): Task[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.projectId) {
      where.push("project_id = ?");
      args.push(filter.projectId);
    }
    if (filter.threadId) {
      where.push("(thread_id = ? OR execution_thread_id = ?)");
      args.push(filter.threadId, filter.threadId);
    }
    if (filter.statuses && filter.statuses.length > 0) {
      where.push(`status IN (${filter.statuses.map(() => "?").join(",")})`);
      args.push(...filter.statuses);
    }
    const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${filter.threadId ? "created_at" : "updated_at DESC"}`;
    return (db.stmt(sql).all(...(args as (string | number)[])) as unknown as TaskRow[]).map(taskFromRow);
  },
  get(db: Db, id: string): Task | null {
    const r = db.stmt("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as TaskRow | undefined;
    return r ? taskFromRow(r) : null;
  },
  insert(
    db: Db,
    t: {
      projectId: string;
      title: string;
      spec: string | null;
      status?: TaskStatus;
      priority: Task["priority"];
      labels: string[];
      workspaceMode: Task["workspaceMode"];
      baseRef: string | null;
      parentTaskId: string | null;
      threadId?: string | null;
      origin?: Task["origin"];
    },
  ): Task {
    const id = randomUUID();
    const ts = now();
    db.stmt(
      "INSERT INTO tasks (id, project_id, title, spec, status, priority, labels, workspace_mode, base_ref, parent_task_id, thread_id, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, t.projectId, t.title, t.spec, t.status ?? "backlog", t.priority, JSON.stringify(t.labels), t.workspaceMode, t.baseRef, t.parentTaskId, t.threadId ?? null, t.origin ?? "user", ts, ts);
    return tasks.get(db, id) as Task;
  },
  /**
   * A live task in the thread that means the same thing: the same title
   * ignoring case and punctuation, or a spec that shares most of its words
   * with an existing one. Agents cannot create the same work twice under a
   * new name.
   */
  findSimilarInThread(db: Db, threadId: string, title: string, spec?: string): Task | null {
    const key = normalizeTitle(title);
    const live = tasks.list(db, { threadId }).filter((t) => t.status !== "archived");
    const byTitle = live.find((t) => normalizeTitle(t.title) === key);
    if (byTitle || !spec) return byTitle ?? null;
    const words = wordSet(`${title} ${spec}`);
    if (words.size < 6) return null;
    return live.find((t) => jaccard(words, wordSet(`${t.title} ${t.spec ?? ""}`)) >= 0.55) ?? null;
  },
  /** Explicit board moves take precedence over subsequent execution projections. */
  update(db: Db, id: string, patch: TaskPatch, options: { explicitStatus?: boolean } = {}): Task {
    const sets: string[] = [];
    const args: unknown[] = [];
    const explicitStatus = options.explicitStatus && patch.status !== undefined;
    for (const [key, value] of Object.entries(patch) as [keyof TaskPatch, unknown][]) {
      if (value === undefined) continue;
      const column = taskColumns[key];
      sets.push(!explicitStatus && (key === "status" || key === "completedAt") ? `${column} = CASE WHEN status_is_explicit = 0 THEN ? ELSE ${column} END` : `${column} = ?`);
      args.push(key === "labels" ? JSON.stringify(value) : value);
    }
    if (explicitStatus) sets.push("status_is_explicit = 1");
    sets.push("updated_at = ?");
    args.push(now(), id);
    db.stmt(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...(args as (string | number | null)[]));
    const t = tasks.get(db, id);
    if (!t) throw new Error(`task ${id} not found`);
    return t;
  },
  addCost(db: Db, id: string, usd: number): void {
    db.stmt("UPDATE tasks SET cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?").run(usd, now(), id);
  },
  /** A conversation's review comments outlive the task they were labeled with; team review comments go with their task. */
  delete(db: Db, id: string): void {
    db.transaction(() => {
      db.stmt("UPDATE review_comments SET task_id = NULL WHERE task_id = ? AND thread_id IS NOT NULL").run(id);
      db.stmt("DELETE FROM tasks WHERE id = ?").run(id);
    });
  },
};

/* Threads */

interface ThreadRow {
  id: string;
  working_directory: string | null;
  project_id: string;
  title: string;
  agent: Thread["agent"];
  model: string | null;
  effort: string | null;
  fast_mode: number;
  mode: Thread["mode"];
  permission_mode: Thread["permissionMode"];
  workspace_mode: Thread["workspaceMode"];
  branch: string | null;
  worktree_path: string | null;
  base_sha: string | null;
  base_branch: string | null;
  pinned_at: number | null;
  seen_at: number | null;
  done_at: number | null;
  snoozed_until: number | null;
  pr_url: string | null;
  pr_state: Thread["prState"];
  forked_from_id: string | null;
  forked_at_run_id: string | null;
  draft: string | null;
  imported_from: string | null;
  orcling_id?: string | null;
  created_at: number;
  updated_at: number;
  last_activity_at: number;
  archived_at: number | null;
}

function threadFromRow(r: ThreadRow): Thread {
  return {
    workingDirectory: r.working_directory,
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    agent: r.agent,
    model: r.model,
    effort: r.effort,
    fastMode: Boolean(r.fast_mode),
    mode: r.mode,
    permissionMode: r.permission_mode,
    workspaceMode: r.workspace_mode,
    branch: r.branch,
    worktreePath: r.worktree_path,
    baseSha: r.base_sha,
    baseBranch: r.base_branch,
    pinnedAt: r.pinned_at,
    seenAt: r.seen_at,
    doneAt: r.done_at,
    snoozedUntil: r.snoozed_until,
    prUrl: r.pr_url,
    prState: r.pr_state,
    forkedFromId: r.forked_from_id,
    forkedAtRunId: r.forked_at_run_id,
    draft: r.draft,
    importedFrom: r.imported_from,
    orclingId: r.orcling_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastActivityAt: r.last_activity_at,
    archivedAt: r.archived_at,
  };
}

export interface ThreadPatch {
  workingDirectory?: string | null;
  title?: string;
  mode?: Thread["mode"];
  permissionMode?: Thread["permissionMode"];
  model?: string | null;
  effort?: string | null;
  fastMode?: boolean;
  agent?: Thread["agent"];
  workspaceMode?: Thread["workspaceMode"];
  branch?: string | null;
  worktreePath?: string | null;
  baseSha?: string | null;
  baseBranch?: string | null;
  pinnedAt?: number | null;
  seenAt?: number | null;
  doneAt?: number | null;
  snoozedUntil?: number | null;
  prUrl?: string | null;
  prState?: Thread["prState"];
  draft?: string | null;
  archivedAt?: number | null;
  orclingId?: string | null;
}

const threadColumns: Record<keyof ThreadPatch, string> = {
  workingDirectory: "working_directory",
  title: "title",
  mode: "mode",
  permissionMode: "permission_mode",
  model: "model",
  effort: "effort",
  fastMode: "fast_mode",
  agent: "agent",
  workspaceMode: "workspace_mode",
  branch: "branch",
  worktreePath: "worktree_path",
  baseSha: "base_sha",
  baseBranch: "base_branch",
  pinnedAt: "pinned_at",
  seenAt: "seen_at",
  doneAt: "done_at",
  snoozedUntil: "snoozed_until",
  prUrl: "pr_url",
  prState: "pr_state",
  draft: "draft",
  archivedAt: "archived_at",
  orclingId: "orcling_id",
};

export type ThreadListFilter = "active" | "done" | "archived" | "all";

export interface ThreadInsert {
  /** Preallocated when workspace admission must precede persistence. */
  id?: string;
  projectId: string;
  title: string;
  agent: Thread["agent"];
  model: string | null;
  effort?: string | null;
  fastMode?: boolean;
  mode: Thread["mode"];
  permissionMode: Thread["permissionMode"];
  workspaceMode?: Thread["workspaceMode"];
  forkedFromId?: string | null;
  forkedAtRunId?: string | null;
  importedFrom?: string | null;
  /** Backdates a thread imported from a CLI transcript. */
  createdAt?: number;
}

/** Hidden owners of retained team tasks stay readable by id and by internal inventories only. */
const VISIBLE = "NOT EXISTS (SELECT 1 FROM team_deleted_threads hidden WHERE hidden.thread_id = threads.id)";

export const threads = {
  /**
   * Active includes every unarchived conversation, including legacy done rows.
   * Pinned first, then most recent activity.
   */
  list(db: Db, filter: { projectId?: string; projectsOnly?: boolean; filter?: ThreadListFilter; limit?: number; offset?: number } = {}): Thread[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.projectId) {
      where.push("project_id = ?");
      args.push(filter.projectId);
    }
    if (filter.projectsOnly) {
      where.push("project_id != ?");
      args.push(WORKSPACE_ID);
    }
    // A deleted team conversation keeps its row for its saved tasks; it is never listed, including with filter=all.
    where.push(VISIBLE);
    const kind = filter.filter ?? "active";
    if (kind === "active") where.push("archived_at IS NULL");
    else if (kind === "done") where.push("archived_at IS NULL AND done_at IS NOT NULL");
    else if (kind === "archived") where.push("archived_at IS NOT NULL");
    const limit = filter.limit ? ` LIMIT ${Math.floor(filter.limit)}${filter.offset ? ` OFFSET ${Math.floor(filter.offset)}` : ""}` : "";
    const sql = `SELECT * FROM threads WHERE ${where.join(" AND ")} ORDER BY ${threadListOrder(kind)}${limit}`;
    return (db.stmt(sql).all(...args) as unknown as ThreadRow[]).map(threadFromRow);
  },
  get(db: Db, id: string): Thread | null {
    const r = db.stmt("SELECT * FROM threads WHERE id = ?").get(id) as unknown as ThreadRow | undefined;
    return r ? threadFromRow(r) : null;
  },
  getByImport(db: Db, importedFrom: string): Thread | null {
    const r = db.stmt("SELECT * FROM threads WHERE imported_from = ?").get(importedFrom) as unknown as ThreadRow | undefined;
    return r ? threadFromRow(r) : null;
  },
  insert(db: Db, t: ThreadInsert): Thread {
    const id = t.id ?? randomUUID();
    const ts = t.createdAt ?? now();
    db.stmt(
      "INSERT INTO threads (id, project_id, title, agent, model, effort, fast_mode, mode, permission_mode, workspace_mode, forked_from_id, forked_at_run_id, imported_from, seen_at, created_at, updated_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id,
      t.projectId,
      t.title,
      t.agent,
      t.model,
      t.effort ?? null,
      Number(t.fastMode ?? false),
      t.mode,
      t.permissionMode,
      t.workspaceMode ?? "current",
      t.forkedFromId ?? null,
      t.forkedAtRunId ?? null,
      t.importedFrom ?? null,
      ts,
      ts,
      ts,
      ts,
    );
    return threads.get(db, id) as Thread;
  },
  /** Threads whose last activity is older than the cutoff and that are still active, for auto-done. */
  idleSince(db: Db, cutoff: number): Thread[] {
    return (db.stmt(`SELECT * FROM threads WHERE ${VISIBLE} AND archived_at IS NULL AND done_at IS NULL AND last_activity_at < ?`).all(cutoff) as unknown as ThreadRow[]).map(threadFromRow);
  },
  doneSince(db: Db, cutoff: number): Thread[] {
    return (db.stmt(`SELECT * FROM threads WHERE ${VISIBLE} AND archived_at IS NULL AND done_at IS NOT NULL AND done_at < ?`).all(cutoff) as unknown as ThreadRow[]).map(threadFromRow);
  },
  withOpenPr(db: Db): Thread[] {
    return (db.stmt(`SELECT * FROM threads WHERE ${VISIBLE} AND pr_url IS NOT NULL AND (pr_state IS NULL OR pr_state = 'open')`).all() as unknown as ThreadRow[]).map(threadFromRow);
  },
  /** Snoozed threads whose time has come. */
  dueFromSnooze(db: Db, at: number): Thread[] {
    return (db.stmt(`SELECT * FROM threads WHERE ${VISIBLE} AND snoozed_until IS NOT NULL AND snoozed_until <= ?`).all(at) as unknown as ThreadRow[]).map(threadFromRow);
  },
  update(db: Db, id: string, patch: ThreadPatch): Thread {
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    for (const [key, value] of Object.entries(patch) as [keyof ThreadPatch, string | number | boolean | null | undefined][]) {
      if (value === undefined) continue;
      sets.push(`${threadColumns[key]} = ?`);
      args.push(typeof value === "boolean" ? Number(value) : value);
    }
    sets.push("updated_at = ?");
    args.push(now(), id);
    db.stmt(`UPDATE threads SET ${sets.join(", ")} WHERE id = ?`).run(...args);
    const t = threads.get(db, id);
    if (!t) throw new Error(`thread ${id} not found`);
    return t;
  },
  touch(db: Db, id: string): void {
    db.stmt("UPDATE threads SET last_activity_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), id);
  },
  delete(db: Db, id: string): void {
    db.transaction(() => {
      db.stmt("UPDATE tasks SET execution_thread_id = NULL WHERE execution_thread_id = ?").run(id);
      db.stmt("DELETE FROM threads WHERE id = ?").run(id);
    });
  },
};

/* Runs */

interface RunRow {
  comment_turn_id: string | null;
  id: string;
  working_directory: string | null;
  task_id: string | null;
  thread_id: string | null;
  agent: Run["agent"];
  model: string | null;
  effort: string | null;
  fast_mode: number;
  mode: Run["mode"];
  permission_mode: Run["permissionMode"];
  external_session_id: string | null;
  state: RunState;
  started_at: number;
  ended_at: number | null;
  usage: string | null;
  result_text: string | null;
  error: string | null;
  orcling_id?: string | null;
}

function runFromRow(r: RunRow): Run {
  return {
    commentTurnId: r.comment_turn_id,
    workingDirectory: r.working_directory,
    id: r.id,
    taskId: r.task_id,
    threadId: r.thread_id,
    agent: r.agent,
    model: r.model,
    effort: r.effort,
    fastMode: Boolean(r.fast_mode),
    mode: r.mode,
    permissionMode: r.permission_mode,
    externalSessionId: r.external_session_id,
    state: r.state,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    usage: r.usage ? (JSON.parse(r.usage) as Usage) : null,
    resultText: r.result_text,
    error: r.error,
    orclingId: r.orcling_id ?? null,
  };
}

export const runs = {
  listForTask(db: Db, taskId: string): Run[] {
    return (db.stmt("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at").all(taskId) as unknown as RunRow[]).map(runFromRow);
  },
  listForThread(db: Db, threadId: string): Run[] {
    return (db.stmt("SELECT * FROM runs WHERE thread_id = ? ORDER BY started_at").all(threadId) as unknown as RunRow[]).map(runFromRow);
  },
  get(db: Db, id: string): Run | null {
    const r = db.stmt("SELECT * FROM runs WHERE id = ?").get(id) as unknown as RunRow | undefined;
    return r ? runFromRow(r) : null;
  },
  insert(
    db: Db,
    r: {
      id: string;
      commentTurnId?: string;
      workingDirectory?: string;
      taskId: string | null;
      threadId: string | null;
      agent: Run["agent"];
      model: string | null;
      effort?: string | null;
      fastMode?: boolean;
      mode: Run["mode"];
      permissionMode: Run["permissionMode"];
      orclingId?: string | null;
    },
  ): Run {
    if ([r.taskId, r.threadId, r.commentTurnId].filter(Boolean).length !== 1) throw new Error("a run belongs to exactly one task, thread or comment turn");
    db.stmt(
      "INSERT INTO runs (id, task_id, thread_id, agent, model, effort, fast_mode, mode, permission_mode, state, started_at, working_directory, comment_turn_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?)",
    ).run(r.id, r.taskId, r.threadId, r.agent, r.model, r.effort ?? null, Number(r.fastMode ?? false), r.mode, r.permissionMode, now(), r.workingDirectory ?? null, r.commentTurnId ?? null);
    // Set apart so ledgers from before Orclings accept every other run unchanged.
    if (r.orclingId) db.stmt("UPDATE runs SET orcling_id = ? WHERE id = ?").run(r.orclingId, r.id);
    return runs.get(db, r.id) as Run;
  },
  update(
    db: Db,
    id: string,
    patch: {
      state?: RunState;
      permissionMode?: Run["permissionMode"];
      externalSessionId?: string | null;
      model?: string | null;
      effort?: string | null;
      fastMode?: boolean;
      endedAt?: number | null;
      usage?: Usage | null;
      resultText?: string | null;
      error?: string | null;
    },
  ): void {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.state !== undefined) {
      sets.push("state = ?");
      args.push(patch.state);
    }
    if (patch.permissionMode !== undefined) {
      sets.push("permission_mode = ?");
      args.push(patch.permissionMode);
    }
    if (patch.externalSessionId !== undefined) {
      sets.push("external_session_id = ?");
      args.push(patch.externalSessionId);
    }
    if (patch.model !== undefined) {
      sets.push("model = ?");
      args.push(patch.model);
    }
    if (patch.effort !== undefined) {
      sets.push("effort = ?");
      args.push(patch.effort);
    }
    if (patch.fastMode !== undefined) {
      sets.push("fast_mode = ?");
      args.push(patch.fastMode ? 1 : 0);
    }
    if (patch.endedAt !== undefined) {
      sets.push("ended_at = ?");
      args.push(patch.endedAt);
    }
    if (patch.usage !== undefined) {
      sets.push("usage = ?");
      args.push(patch.usage ? JSON.stringify(patch.usage) : null);
    }
    if (patch.resultText !== undefined) {
      sets.push("result_text = ?");
      args.push(patch.resultText === null ? null : redact(patch.resultText).text);
    }
    if (patch.error !== undefined) {
      sets.push("error = ?");
      args.push(patch.error === null ? null : redact(patch.error).text);
    }
    if (sets.length === 0) return;
    args.push(id);
    db.stmt(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(...(args as (string | number | null)[]));
  },
  /** Runs the app left open when it last quit: they will never finish on their own. */
  listUnfinished(db: Db): Run[] {
    return (db.stmt("SELECT * FROM runs WHERE state IN ('starting', 'running') ORDER BY started_at").all() as unknown as RunRow[]).map(runFromRow);
  },
  /** The thread whose run produced a provider session, so the CLI's copy is not offered for import twice. */
  threadForSession(db: Db, externalSessionId: string): string | null {
    const r = db.stmt("SELECT thread_id FROM runs WHERE external_session_id = ? AND thread_id IS NOT NULL LIMIT 1").get(externalSessionId) as { thread_id: string } | undefined;
    return r?.thread_id ?? null;
  },
  /** The most recent session id for a task or thread, so a new run can resume it. */
  /** The newest session of this provider in a task or thread, spoken by the same Orcling or, without one, by no Orcling. */
  lastSession(db: Db, scope: { taskId: string } | { threadId: string }, agent: Run["agent"], orclingId: string | null = null): string | null {
    const column = "taskId" in scope ? "task_id" : "thread_id";
    const id = "taskId" in scope ? scope.taskId : scope.threadId;
    const r = db
      .stmt(`SELECT external_session_id FROM runs WHERE ${column} = ? AND agent = ? AND orcling_id IS ? AND external_session_id IS NOT NULL ORDER BY started_at DESC LIMIT 1`)
      .get(id, agent, orclingId) as { external_session_id: string } | undefined;
    return r?.external_session_id ?? null;
  },
};

/* Snapshots */

interface SnapshotRow {
  id: string;
  task_id: string;
  run_id: string | null;
  turn: number;
  tree_sha: string;
  diff_stat: string;
  created_at: number;
}

export const snapshots = {
  get(db: Db, id: string): Snapshot | null {
    const r = db.stmt("SELECT * FROM snapshots WHERE id = ?").get(id) as unknown as SnapshotRow | undefined;
    return r ? { id: r.id, taskId: r.task_id, runId: r.run_id, turn: r.turn, treeSha: r.tree_sha, diffStat: JSON.parse(r.diff_stat) as Snapshot["diffStat"], createdAt: r.created_at } : null;
  },
  latestForTask(db: Db, taskId: string): Snapshot | null {
    const r = db.stmt("SELECT * FROM snapshots WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").get(taskId) as unknown as SnapshotRow | undefined;
    return r ? snapshots.get(db, r.id) : null;
  },
  listForTask(db: Db, taskId: string): Snapshot[] {
    return (db.stmt("SELECT * FROM snapshots WHERE task_id = ? ORDER BY created_at").all(taskId) as unknown as SnapshotRow[]).map((r) => ({
      id: r.id,
      taskId: r.task_id,
      runId: r.run_id,
      turn: r.turn,
      treeSha: r.tree_sha,
      diffStat: JSON.parse(r.diff_stat) as Snapshot["diffStat"],
      createdAt: r.created_at,
    }));
  },
  insert(db: Db, s: { taskId: string; runId: string | null; turn: number; treeSha: string; diffStat: Snapshot["diffStat"] }): Snapshot {
    const id = randomUUID();
    const t = now();
    db.stmt("INSERT INTO snapshots (id, task_id, run_id, turn, tree_sha, diff_stat, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      id,
      s.taskId,
      s.runId,
      s.turn,
      s.treeSha,
      JSON.stringify(s.diffStat),
      t,
    );
    return { id, taskId: s.taskId, runId: s.runId, turn: s.turn, treeSha: s.treeSha, diffStat: s.diffStat, createdAt: t };
  },
};

/* Audit */

export const audit = {
  record(db: Db, e: { actor: string; action: string; resourceType: string; resourceId: string | null; metadata?: Record<string, unknown> }): void {
    db.stmt("INSERT INTO audit_events (actor, action, resource_type, resource_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      e.actor,
      e.action,
      e.resourceType,
      e.resourceId,
      redactJson(e.metadata ?? {}),
      now(),
    );
  },
};
