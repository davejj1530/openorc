import { randomUUID } from "node:crypto";
import type { AgentKind, Automation, AutomationAction, AutomationDraft, AutomationTrigger, Task, Thread } from "@openorc/protocol";
import type { Db } from "./database.js";
import { tasks, threads } from "./repos.js";
import { retiredTaskIds } from "./retired-teams.js";
import { VISIBLE } from "./thread-visible.js";

/**
 * A project's automations, and what each has already answered to. An automation remembers when it was switched on and
 * when it last looked, so one switched on acts only on what happens from then. A firing is one thing that happened,
 * by a key that tells it from the others, kept so it is acted on once.
 */
export const automationsMigration = `
CREATE TABLE automations (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 trigger TEXT NOT NULL,
 actions TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
 proposed INTEGER NOT NULL DEFAULT 0 CHECK (proposed IN (0, 1)),
 made_by_agent TEXT,
 made_by_thread_id TEXT,
 watching_since INTEGER,
 looked_at INTEGER,
 problem TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX automations_project ON automations(project_id, created_at);
CREATE TABLE automation_firings (
 automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
 key TEXT NOT NULL,
 at INTEGER NOT NULL,
 acted INTEGER NOT NULL CHECK (acted IN (0, 1)),
 thread_id TEXT,
 PRIMARY KEY (automation_id, key)
) WITHOUT ROWID;
CREATE INDEX automation_firings_thread ON automation_firings(thread_id) WHERE thread_id IS NOT NULL;
`;

interface AutomationRow {
  id: string;
  project_id: string;
  task_id: string | null;
  name: string;
  trigger: string;
  actions: string;
  enabled: number;
  proposed: number;
  made_by_agent: AgentKind | null;
  made_by_thread_id: string | null;
  made_by_title: string | null;
  watching_since: number | null;
  looked_at: number | null;
  problem: string | null;
  last_fired_at: number | null;
  created_at: number;
}

/** An automation with what its engine keeps on it: since when it acts, and when it last looked. Never looked, its next look only notes what is there. */
export type WatchedAutomation = Automation & { watchingSince: number; lookedAt: number | null };

const SELECT = `SELECT a.*, t.title AS made_by_title, (SELECT max(f.at) FROM automation_firings f WHERE f.automation_id = a.id AND f.acted = 1) AS last_fired_at
 FROM automations a LEFT JOIN threads t ON t.id = a.made_by_thread_id`;

const fromRow = (row: AutomationRow): WatchedAutomation => ({
  id: row.id,
  projectId: row.project_id,
  taskId: row.task_id,
  name: row.name,
  trigger: JSON.parse(row.trigger) as AutomationTrigger,
  actions: JSON.parse(row.actions) as AutomationAction[],
  enabled: row.enabled === 1,
  proposed: row.proposed === 1,
  // A thread that is gone leaves the agent that wrote it.
  madeBy: row.made_by_agent ? { agent: row.made_by_agent, threadId: row.made_by_title === null ? null : row.made_by_thread_id, threadTitle: row.made_by_title } : null,
  lastFiredAt: row.last_fired_at,
  problem: row.problem,
  createdAt: row.created_at,
  watchingSince: row.watching_since ?? row.created_at,
  lookedAt: row.looked_at,
});

const publicOf = ({ watchingSince: _since, lookedAt: _looked, ...automation }: WatchedAutomation): Automation => automation;

/** What a pull request belongs to here: the thread that opened it, and the task that thread works on. */
export const pullRequestOwners = {
  /** The thread that opened this pull request, the latest when several name it. */
  thread(db: Db, projectId: string, url: string): Thread | null {
    const row = db.stmt(`SELECT id FROM threads WHERE ${VISIBLE} AND project_id = ? AND pr_url = ? ORDER BY last_activity_at DESC LIMIT 1`).get(projectId, url) as { id: string } | undefined;
    return row ? threads.get(db, row.id) : null;
  },
  /** The task whose work a thread does, or that the thread was started for: the latest, and never an archived one. */
  task(db: Db, threadId: string): Task | null {
    const row = db
      .stmt(
        `SELECT id FROM tasks WHERE status != 'archived' AND id NOT IN (${retiredTaskIds})
          AND (execution_thread_id = ?1 OR id IN (SELECT task_id FROM task_threads WHERE thread_id = ?1)) ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(threadId) as { id: string } | undefined;
    return row ? tasks.get(db, row.id) : null;
  },
};

export const automations = {
  list(db: Db, projectId?: string): Automation[] {
    const rows = db.stmt(`${SELECT} WHERE (?1 IS NULL OR a.project_id = ?1) ORDER BY a.created_at, a.id`).all(projectId ?? null);
    return (rows as unknown as AutomationRow[]).map(fromRow).map(publicOf);
  },
  get(db: Db, id: string): Automation | null {
    const row = db.stmt(`${SELECT} WHERE a.id = ?`).get(id) as unknown as AutomationRow | undefined;
    return row ? publicOf(fromRow(row)) : null;
  },
  /** The ones switched on, for the engine. */
  watching(db: Db): WatchedAutomation[] {
    return (db.stmt(`${SELECT} WHERE a.enabled = 1 ORDER BY a.created_at, a.id`).all() as unknown as AutomationRow[]).map(fromRow);
  },
  /** A person's starts switched on; an agent's waits, proposed, for the person. */
  insert(db: Db, draft: AutomationDraft, madeBy?: { agent: AgentKind; threadId: string }): Automation {
    const id = randomUUID();
    const now = Date.now();
    db.stmt(
      `INSERT INTO automations (id, project_id, task_id, name, trigger, actions, enabled, proposed, made_by_agent, made_by_thread_id, watching_since, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      draft.projectId,
      draft.taskId ?? null,
      draft.name,
      JSON.stringify(draft.trigger),
      JSON.stringify(draft.actions),
      Number(!madeBy),
      Number(Boolean(madeBy)),
      madeBy?.agent ?? null,
      madeBy?.threadId ?? null,
      madeBy ? null : now,
      now,
      now,
    );
    return automations.get(db, id) as Automation;
  },
  /** What it waits for and does, rewritten. It looks afresh, since what it noted was noted for the trigger it had. */
  rewrite(db: Db, id: string, draft: Pick<AutomationDraft, "name" | "trigger" | "actions">): Automation {
    const now = Date.now();
    db.transaction(() => {
      db.stmt("UPDATE automations SET name = ?, trigger = ?, actions = ?, watching_since = ?, looked_at = NULL, problem = NULL, updated_at = ? WHERE id = ?").run(
        draft.name,
        JSON.stringify(draft.trigger),
        JSON.stringify(draft.actions),
        now,
        now,
        id,
      );
      db.stmt("DELETE FROM automation_firings WHERE automation_id = ? AND acted = 0").run(id);
    });
    return automations.get(db, id) as Automation;
  },
  /** Switched on, it acts on what happens from now, and one an agent proposed is the person's from then. */
  setEnabled(db: Db, id: string, enabled: boolean): void {
    const now = Date.now();
    if (!enabled) return void db.stmt("UPDATE automations SET enabled = 0, updated_at = ? WHERE id = ?").run(now, id);
    db.transaction(() => {
      db.stmt("UPDATE automations SET enabled = 1, proposed = 0, watching_since = ?, looked_at = NULL, problem = NULL, updated_at = ? WHERE id = ?").run(now, now, id);
      db.stmt("DELETE FROM automation_firings WHERE automation_id = ? AND acted = 0").run(id);
    });
  },
  remove(db: Db, id: string): void {
    db.stmt("DELETE FROM automations WHERE id = ?").run(id);
  },
  /** A look done: when, and what went wrong with it, if anything did. */
  looked(db: Db, id: string, problem: string | null): void {
    db.stmt("UPDATE automations SET looked_at = ?, problem = ? WHERE id = ?").run(Date.now(), problem, id);
  },
  /** Switched off by the app itself, with why. */
  halt(db: Db, id: string, problem: string): void {
    db.stmt("UPDATE automations SET enabled = 0, problem = ?, updated_at = ? WHERE id = ?").run(problem, Date.now(), id);
  },
};

export const automationFirings = {
  /** Which of these keys the automation has already answered to. */
  seen(db: Db, automationId: string, keys: readonly string[]): Set<string> {
    if (keys.length === 0) return new Set();
    const rows = db.stmt("SELECT key FROM automation_firings WHERE automation_id = ? AND key IN (SELECT value FROM json_each(?))").all(automationId, JSON.stringify(keys));
    return new Set((rows as unknown as { key: string }[]).map((row) => row.key));
  },
  /** One thing that happened, noted so it is not answered to again. `acted` is false for what was only noted. */
  record(db: Db, automationId: string, key: string, outcome: { acted: boolean; threadId?: string | null }): void {
    db.stmt("INSERT OR REPLACE INTO automation_firings (automation_id, key, at, acted, thread_id) VALUES (?, ?, ?, ?, ?)").run(
      automationId,
      key,
      Date.now(),
      Number(outcome.acted),
      outcome.threadId ?? null,
    );
  },
  actedSince(db: Db, automationId: string, since: number): number {
    const row = db.stmt("SELECT count(*) AS n FROM automation_firings WHERE automation_id = ? AND acted = 1 AND at >= ?").get(automationId, since);
    return (row as { n: number }).n;
  },
  /** Whether an automation started this thread, so what the thread makes does not set automations off in turn. */
  startedThread(db: Db, threadId: string): boolean {
    return Boolean(db.stmt("SELECT 1 FROM automation_firings WHERE thread_id = ? LIMIT 1").get(threadId));
  },
};
