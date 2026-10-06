import { taskCommentsMigration } from "./task-comments-schema.js";
import type { DatabaseSync } from "node:sqlite";
import { teamTaskMigration } from "./team-task-schema.js";
import { scheduleMigration, teamNotificationMigration } from "./schedule-schema.js";
import { teamOriginMigration } from "./team-origin-schema.js";
import { teamForkMigration } from "./team-fork-schema.js";
import { teamRestoreMigration } from "./team-restore-schema.js";
import { teamForkRejectionMigration } from "./team-fork-rejection-schema.js";
import { teamMoveMigration } from "./team-move-schema.js";
import { teamDeleteMigration } from "./team-delete-schema.js";
import { teamContextPartMigration } from "./team-context-part-schema.js";
import { teamCleanupMigration } from "./team-cleanup-schema.js";
import { teamRoomMigration } from "./team-room-schema.js";
import { teamDiscussionMigration } from "./team-discussion-schema.js";
import { teamLocalStartMigration } from "./team-local-start-schema.js";
import { teamHarnessMigration } from "./team-harness-schema.js";
import { teamJournalMigration } from "./team-journal-schema.js";
import { taskExecutionMigration } from "./task-execution-schema.js";
import { conversationReviewCommentsMigration } from "./review-comments-schema.js";
import { teamCancellationMigration } from "./team-cancellation-schema.js";
import { pullRequestReviewMigration } from "./pull-review-schema.js";
import { orclingMigration } from "./orcling-schema.js";
/**
 * Migrations run in order; `PRAGMA user_version` records how many applied.
 * Never edit a shipped migration. Append a new one.
 */
export type Migration = string | ((raw: DatabaseSync) => void);

export const migrations: Migration[] = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL UNIQUE,
    git_remote TEXT,
    default_branch TEXT,
    settings TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    spec TEXT,
    status TEXT NOT NULL DEFAULT 'backlog',
    priority TEXT NOT NULL DEFAULT 'none',
    labels TEXT NOT NULL DEFAULT '[]',
    workspace_mode TEXT NOT NULL DEFAULT 'worktree',
    base_ref TEXT,
    base_sha TEXT,
    branch TEXT,
    worktree_path TEXT,
    parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    cost_usd REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
  );
  CREATE INDEX tasks_project_status ON tasks(project_id, status, updated_at DESC);

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    agent TEXT NOT NULL,
    model TEXT,
    mode TEXT NOT NULL DEFAULT 'act',
    permission_mode TEXT NOT NULL DEFAULT 'trusted',
    external_session_id TEXT,
    state TEXT NOT NULL DEFAULT 'starting',
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    usage TEXT,
    result_text TEXT
  );
  CREATE INDEX runs_task ON runs(task_id, started_at);

  -- Append-only. One row per agent event, in arrival order per run.
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    tool_name TEXT,
    parent_tool_call_id TEXT,
    payload TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    redacted INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL,
    UNIQUE(run_id, seq)
  );

  -- Large payloads live here; the event keeps a preview and a pointer.
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    path TEXT,
    sha256 TEXT NOT NULL,
    content TEXT NOT NULL,
    bytes INTEGER NOT NULL
  );
  CREATE INDEX artifacts_event ON artifacts(event_id);

  CREATE TABLE snapshots (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
    turn INTEGER NOT NULL,
    tree_sha TEXT NOT NULL,
    diff_stat TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX snapshots_task ON snapshots(task_id, created_at);

  CREATE TABLE review_comments (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    snapshot_id TEXT REFERENCES snapshots(id) ON DELETE SET NULL,
    path TEXT NOT NULL,
    line INTEGER,
    side TEXT,
    body TEXT NOT NULL,
    sent_in_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );

  -- Enterprise foundation: who did what, exportable as JSONL.
  CREATE TABLE audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  `,
  `
  -- The snapshot the user last looked at, so the Files tab can show only what changed since.
  ALTER TABLE tasks ADD COLUMN reviewed_snapshot_id TEXT REFERENCES snapshots(id) ON DELETE SET NULL;
  `,
  `
  -- Memory: what runs taught us, distilled. Typed, scoped, with provenance and decay.
  CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL DEFAULT 'project',
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    topic_key TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.6,
    status TEXT NOT NULL DEFAULT 'active',
    source TEXT NOT NULL DEFAULT 'extraction',
    source_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
    source_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    evidence_count INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_confirmed_at INTEGER NOT NULL,
    supersedes_id TEXT,
    expires_at INTEGER
  );
  CREATE INDEX memories_project_status ON memories(project_id, status, type);
  CREATE INDEX memories_task ON memories(source_task_id);
  CREATE UNIQUE INDEX memories_topic ON memories(project_id, topic_key) WHERE topic_key IS NOT NULL AND status = 'active';

  CREATE TABLE memory_files (
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    path_glob TEXT NOT NULL
  );

  CREATE VIRTUAL TABLE memories_fts USING fts5(title, body, content='memories', content_rowid='rowid');
  CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
  END;
  CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  END;
  CREATE TRIGGER memories_au AFTER UPDATE OF title, body ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
    INSERT INTO memories_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
  END;

  -- One summary per run, written by the extractor after the run ends.
  CREATE TABLE session_summaries (
    run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    request TEXT NOT NULL,
    work_done TEXT NOT NULL,
    outcome TEXT NOT NULL,
    open_items TEXT NOT NULL DEFAULT '[]',
    model TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX session_summaries_project ON session_summaries(project_id, created_at DESC);

  CREATE TABLE extraction_jobs (
    run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    state TEXT NOT NULL,
    error TEXT,
    memories_written INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    finished_at INTEGER
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  /**
   * Threads: the conversation a user has with an agent in the project root.
   * Runs and summaries now belong to a thread or a task; tasks remember the
   * thread that spawned them. task_id loses NOT NULL, which SQLite can only do
   * by rebuilding the table, so the runner keeps foreign keys off meanwhile.
   */
  (raw) => {
    raw.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        agent TEXT NOT NULL,
        model TEXT,
        mode TEXT NOT NULL DEFAULT 'act',
        permission_mode TEXT NOT NULL DEFAULT 'trusted',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        archived_at INTEGER
      );
      CREATE INDEX threads_project ON threads(project_id, last_activity_at DESC);

      CREATE TABLE runs_new (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
        agent TEXT NOT NULL,
        model TEXT,
        mode TEXT NOT NULL DEFAULT 'act',
        permission_mode TEXT NOT NULL DEFAULT 'trusted',
        external_session_id TEXT,
        state TEXT NOT NULL DEFAULT 'starting',
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        usage TEXT,
        result_text TEXT
      );
      INSERT INTO runs_new (id, task_id, agent, model, mode, permission_mode, external_session_id, state, started_at, ended_at, usage, result_text)
        SELECT id, task_id, agent, model, mode, permission_mode, external_session_id, state, started_at, ended_at, usage, result_text FROM runs;
      DROP TABLE runs;
      ALTER TABLE runs_new RENAME TO runs;
      CREATE INDEX runs_task ON runs(task_id, started_at);
      CREATE INDEX runs_thread ON runs(thread_id, started_at);

      CREATE TABLE session_summaries_new (
        run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        request TEXT NOT NULL,
        work_done TEXT NOT NULL,
        outcome TEXT NOT NULL,
        open_items TEXT NOT NULL DEFAULT '[]',
        model TEXT,
        created_at INTEGER NOT NULL
      );
      INSERT INTO session_summaries_new (run_id, task_id, project_id, request, work_done, outcome, open_items, model, created_at)
        SELECT run_id, task_id, project_id, request, work_done, outcome, open_items, model, created_at FROM session_summaries;
      DROP TABLE session_summaries;
      ALTER TABLE session_summaries_new RENAME TO session_summaries;
      CREATE INDEX session_summaries_project ON session_summaries(project_id, created_at DESC);

      ALTER TABLE tasks ADD COLUMN thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL;
      ALTER TABLE tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'user';
      CREATE INDEX tasks_thread ON tasks(thread_id, created_at);
    `);
  },
  `
  -- Reasoning effort travels with the model choice.
  ALTER TABLE runs ADD COLUMN effort TEXT;
  ALTER TABLE threads ADD COLUMN effort TEXT;
  `,
  /**
   * Threads grow up: a workspace of their own (root or worktree), a lifecycle
   * beyond archive (pinned, done, snoozed, seen), a pull request, a parent
   * when forked, a saved draft, and a checkpoint per turn so the tree can be
   * rewound. Runs remember why they failed. Messages get a full-text index so
   * search reaches into conversations, backfilled from the ledger.
   */
  `
  ALTER TABLE threads ADD COLUMN workspace_mode TEXT NOT NULL DEFAULT 'current';
  ALTER TABLE threads ADD COLUMN branch TEXT;
  ALTER TABLE threads ADD COLUMN worktree_path TEXT;
  ALTER TABLE threads ADD COLUMN base_sha TEXT;
  ALTER TABLE threads ADD COLUMN pinned_at INTEGER;
  ALTER TABLE threads ADD COLUMN seen_at INTEGER;
  ALTER TABLE threads ADD COLUMN done_at INTEGER;
  ALTER TABLE threads ADD COLUMN snoozed_until INTEGER;
  ALTER TABLE threads ADD COLUMN pr_url TEXT;
  ALTER TABLE threads ADD COLUMN pr_state TEXT;
  ALTER TABLE threads ADD COLUMN forked_from_id TEXT REFERENCES threads(id) ON DELETE SET NULL;
  ALTER TABLE threads ADD COLUMN forked_at_run_id TEXT;
  ALTER TABLE threads ADD COLUMN draft TEXT;
  ALTER TABLE threads ADD COLUMN imported_from TEXT;
  UPDATE threads SET seen_at = last_activity_at;

  ALTER TABLE runs ADD COLUMN error TEXT;

  CREATE TABLE thread_checkpoints (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
    turn INTEGER NOT NULL,
    tree_sha TEXT NOT NULL,
    diff_stat TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX thread_checkpoints_thread ON thread_checkpoints(thread_id, created_at);

  CREATE VIRTUAL TABLE messages_fts USING fts5(text, run_id UNINDEXED, role UNINDEXED, ts UNINDEXED, message_id UNINDEXED);
  INSERT INTO messages_fts (text, run_id, role, ts, message_id)
    SELECT json_extract(payload, '$.text'), run_id, json_extract(payload, '$.role'), ts, json_extract(payload, '$.messageId')
    FROM events
    WHERE kind = 'message.completed' AND json_extract(payload, '$.role') IN ('user', 'assistant') AND json_extract(payload, '$.text') IS NOT NULL;

  CREATE TABLE schedules (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    agent TEXT NOT NULL,
    model TEXT,
    effort TEXT,
    mode TEXT NOT NULL DEFAULT 'act',
    permission_mode TEXT NOT NULL DEFAULT 'trusted',
    workspace_mode TEXT NOT NULL DEFAULT 'worktree',
    every_minutes INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at INTEGER,
    next_run_at INTEGER NOT NULL,
    last_thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  /** Fast is explicit opt-in; existing conversations and runs stay Standard. */
  `
  ALTER TABLE threads ADD COLUMN fast_mode INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE runs ADD COLUMN fast_mode INTEGER NOT NULL DEFAULT 0;
  `,
  /** Saved teams are configuration only; execution is introduced separately. */
  `
  CREATE TABLE orchestration_teams (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    current_revision_id TEXT NOT NULL,
    archived_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(id, project_id),
    FOREIGN KEY(current_revision_id, id, project_id)
      REFERENCES orchestration_team_revisions(id, team_id, project_id)
      DEFERRABLE INITIALLY DEFERRED
  );
  CREATE INDEX orchestration_teams_project ON orchestration_teams(project_id, archived_at, updated_at DESC);

  CREATE TABLE orchestration_team_revisions (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    number INTEGER NOT NULL CHECK(number > 0),
    name TEXT NOT NULL,
    limits TEXT NOT NULL CHECK(json_valid(limits)),
    sealed INTEGER NOT NULL DEFAULT 0 CHECK(sealed IN (0, 1)),
    created_at INTEGER NOT NULL,
    UNIQUE(team_id, number),
    UNIQUE(id, team_id, project_id),
    UNIQUE(id, project_id),
    FOREIGN KEY(team_id, project_id) REFERENCES orchestration_teams(id, project_id) ON DELETE CASCADE
  );

  CREATE TABLE orchestration_team_members (
    revision_id TEXT NOT NULL REFERENCES orchestration_team_revisions(id) ON DELETE CASCADE,
    member_key TEXT NOT NULL,
    position INTEGER NOT NULL CHECK(position >= 0),
    name TEXT NOT NULL,
    responsibility TEXT NOT NULL,
    manager_key TEXT,
    agent TEXT NOT NULL CHECK(agent IN ('codex', 'claude')),
    model TEXT NOT NULL,
    effort TEXT,
    fast_mode INTEGER NOT NULL CHECK(fast_mode IN (0, 1)),
    PRIMARY KEY(revision_id, member_key),
    UNIQUE(revision_id, position),
    FOREIGN KEY(revision_id, manager_key) REFERENCES orchestration_team_members(revision_id, member_key)
      DEFERRABLE INITIALLY DEFERRED
  );
  CREATE UNIQUE INDEX orchestration_team_lead ON orchestration_team_members(revision_id) WHERE manager_key IS NULL;

  -- A revision is assembled and sealed within one transaction. Its contents
  -- cannot subsequently change, even through a future repository mistake.
  CREATE TRIGGER orchestration_revision_immutable_update BEFORE UPDATE ON orchestration_team_revisions
  WHEN OLD.sealed = 1 BEGIN
    SELECT RAISE(ABORT, 'Saved team revisions are immutable.');
  END;
  CREATE TRIGGER orchestration_revision_immutable_delete BEFORE DELETE ON orchestration_team_revisions
  WHEN OLD.sealed = 1 AND EXISTS(SELECT 1 FROM projects WHERE id = OLD.project_id) BEGIN
    SELECT RAISE(ABORT, 'Saved team revisions are retained. Archive the team instead.');
  END;
  CREATE TRIGGER orchestration_member_immutable_insert BEFORE INSERT ON orchestration_team_members
  WHEN EXISTS(SELECT 1 FROM orchestration_team_revisions WHERE id = NEW.revision_id AND sealed = 1) BEGIN
    SELECT RAISE(ABORT, 'Saved team members are immutable.');
  END;
  CREATE TRIGGER orchestration_member_immutable_update BEFORE UPDATE ON orchestration_team_members
  WHEN EXISTS(SELECT 1 FROM orchestration_team_revisions WHERE id IN (OLD.revision_id, NEW.revision_id) AND sealed = 1) BEGIN
    SELECT RAISE(ABORT, 'Saved team members are immutable.');
  END;
  CREATE TRIGGER orchestration_member_immutable_delete BEFORE DELETE ON orchestration_team_members
  WHEN EXISTS(SELECT 1 FROM orchestration_team_revisions r JOIN projects p ON p.id = r.project_id WHERE r.id = OLD.revision_id AND r.sealed = 1) BEGIN
    SELECT RAISE(ABORT, 'Saved team members are retained. Archive the team instead.');
  END;

  CREATE UNIQUE INDEX threads_id_project ON threads(id, project_id);
  CREATE TABLE orchestration_team_instances (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    team_revision_id TEXT NOT NULL,
    lead_overrides TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(lead_overrides)),
    configuration_version INTEGER NOT NULL DEFAULT 1 CHECK(configuration_version > 0),
    created_at INTEGER NOT NULL,
    UNIQUE(id, team_revision_id),
    FOREIGN KEY(thread_id, project_id) REFERENCES threads(id, project_id) ON DELETE CASCADE,
    FOREIGN KEY(team_revision_id, project_id) REFERENCES orchestration_team_revisions(id, project_id)
  );
  CREATE TABLE orchestration_instance_members (
    id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    team_revision_id TEXT NOT NULL,
    member_key TEXT NOT NULL,
    UNIQUE(instance_id, member_key),
    FOREIGN KEY(instance_id, team_revision_id) REFERENCES orchestration_team_instances(id, team_revision_id) ON DELETE CASCADE,
    FOREIGN KEY(team_revision_id, member_key) REFERENCES orchestration_team_members(revision_id, member_key)
  );
  `,
  /** Execution journals contain coordination state; provider events stay in runs/events. */
  `
  CREATE UNIQUE INDEX orchestration_instances_owner ON orchestration_team_instances(id, thread_id, project_id);
  CREATE TABLE team_executions (
    id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('active', 'attention', 'stopping', 'stopped', 'completed')),
    generation INTEGER NOT NULL CHECK(generation > 0),
    revision INTEGER NOT NULL CHECK(revision >= 0),
    payload TEXT NOT NULL CHECK(json_valid(payload)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(instance_id, thread_id, project_id)
      REFERENCES orchestration_team_instances(id, thread_id, project_id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX team_executions_open_thread ON team_executions(thread_id)
    WHERE state NOT IN ('completed', 'stopped');
  CREATE INDEX team_executions_state ON team_executions(state, updated_at);
  CREATE INDEX team_executions_instance ON team_executions(instance_id, created_at);

  CREATE TABLE team_assignment_bindings (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) DEFERRABLE INITIALLY DEFERRED,
    execution_id TEXT NOT NULL REFERENCES team_executions(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL,
    UNIQUE(execution_id, actor_id)
  );
  CREATE TABLE team_run_bindings (
    run_id TEXT PRIMARY KEY REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED,
    execution_id TEXT NOT NULL REFERENCES team_executions(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation > 0),
    UNIQUE(execution_id, attempt_id)
  );
  CREATE INDEX team_run_bindings_actor ON team_run_bindings(execution_id, actor_id);
  CREATE TRIGGER team_run_binding_immutable BEFORE UPDATE ON team_run_bindings BEGIN
    SELECT RAISE(ABORT, 'Team run bindings are immutable.');
  END;
  CREATE TRIGGER team_assignment_binding_immutable BEFORE UPDATE ON team_assignment_bindings BEGIN
    SELECT RAISE(ABORT, 'Team task bindings are immutable.');
  END;
  `,
  /** Retained exact inputs and replayable filesystem publication intents. */
  `
  CREATE TABLE team_workspaces (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL REFERENCES team_executions(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload)),
    created_at INTEGER NOT NULL,
    UNIQUE(execution_id, actor_id)
  );
  CREATE TABLE team_publications (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL REFERENCES team_executions(id) ON DELETE CASCADE,
    source_actor_id TEXT NOT NULL,
    target_actor_id TEXT NOT NULL,
    output_tree TEXT NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload)),
    created_at INTEGER NOT NULL,
    UNIQUE(execution_id, source_actor_id, target_actor_id, output_tree)
  );
  `,
  /** Immutable session reset boundaries retain context without rewriting attempts. */
  `
  CREATE UNIQUE INDEX team_executions_context_owner ON team_executions(id, instance_id);
  CREATE TABLE team_context_checkpoints (
    id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL REFERENCES orchestration_team_instances(id) ON DELETE CASCADE,
    execution_id TEXT,
    actor_id TEXT NOT NULL CHECK(length(actor_id) > 0),
    origin_execution_id TEXT,
    epoch INTEGER NOT NULL CHECK(epoch > 0),
    reason TEXT NOT NULL CHECK(reason IN ('fresh_retry', 'compact')),
    request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 200),
    seed TEXT NOT NULL CHECK(length(CAST(seed AS BLOB)) <= 65536),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    CHECK((execution_id IS NULL AND actor_id = 'lead') OR (execution_id IS NOT NULL AND actor_id <> 'lead')),
    CHECK(reason <> 'fresh_retry' OR origin_execution_id IS NOT NULL),
    CHECK(reason <> 'compact' OR (execution_id IS NULL AND actor_id = 'lead' AND origin_execution_id IS NULL)),
    CHECK(execution_id IS NULL OR (origin_execution_id IS NOT NULL AND origin_execution_id = execution_id)),
    FOREIGN KEY(execution_id, instance_id) REFERENCES team_executions(id, instance_id) ON DELETE CASCADE,
    FOREIGN KEY(origin_execution_id, instance_id) REFERENCES team_executions(id, instance_id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX team_context_epoch ON team_context_checkpoints(instance_id, COALESCE(execution_id, ''), actor_id, epoch);
  CREATE UNIQUE INDEX team_context_request ON team_context_checkpoints(instance_id, COALESCE(execution_id, ''), actor_id, request_key);
  CREATE TRIGGER team_context_immutable_update BEFORE UPDATE ON team_context_checkpoints BEGIN
    SELECT RAISE(ABORT, 'Team context checkpoints are immutable.');
  END;
  CREATE TRIGGER team_context_immutable_delete BEFORE DELETE ON team_context_checkpoints
  WHEN EXISTS(SELECT 1 FROM orchestration_team_instances WHERE id = OLD.instance_id) BEGIN
    SELECT RAISE(ABORT, 'Team context checkpoints are retained with their instance.');
  END;
  CREATE TRIGGER team_context_actor_insert BEFORE INSERT ON team_context_checkpoints
  WHEN NEW.origin_execution_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM team_executions e, json_each(e.payload, '$.actors') actor
    WHERE e.id = NEW.origin_execution_id AND e.instance_id = NEW.instance_id
      AND json_extract(e.payload, '$.id') = e.id
      AND json_extract(e.payload, '$.instanceId') = NEW.instance_id
      AND json_extract(actor.value, '$.id') = NEW.actor_id
      AND (NEW.actor_id = 'lead' OR EXISTS (
        SELECT 1 FROM team_assignment_bindings b
        WHERE b.execution_id = e.id AND b.actor_id = NEW.actor_id
          AND b.task_id = json_extract(actor.value, '$.taskId')
      ))
  ) BEGIN
    SELECT RAISE(ABORT, 'Context actor must belong to its originating execution.');
  END;
  `,
  /** A task keeps every assignment identity; later follow-ups reserve it anew. */
  `
  DROP TRIGGER team_context_actor_insert;
  DROP TRIGGER team_assignment_binding_immutable;
  CREATE TABLE team_assignment_bindings_v12 (
    binding_order INTEGER PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) DEFERRABLE INITIALLY DEFERRED,
    execution_id TEXT NOT NULL REFERENCES team_executions(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL,
    UNIQUE(execution_id, actor_id)
  );
  INSERT INTO team_assignment_bindings_v12 (binding_order, task_id, execution_id, actor_id)
    SELECT rowid, task_id, execution_id, actor_id FROM team_assignment_bindings ORDER BY rowid;
  DROP TABLE team_assignment_bindings;
  ALTER TABLE team_assignment_bindings_v12 RENAME TO team_assignment_bindings;
  CREATE INDEX team_assignment_bindings_task ON team_assignment_bindings(task_id, binding_order);
  CREATE TRIGGER team_assignment_binding_immutable BEFORE UPDATE ON team_assignment_bindings BEGIN
    SELECT RAISE(ABORT, 'Team task bindings are immutable.');
  END;
  CREATE TRIGGER team_context_actor_insert BEFORE INSERT ON team_context_checkpoints
  WHEN NEW.origin_execution_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM team_executions e, json_each(e.payload, '$.actors') actor
    WHERE e.id = NEW.origin_execution_id AND e.instance_id = NEW.instance_id
      AND json_extract(e.payload, '$.id') = e.id
      AND json_extract(e.payload, '$.instanceId') = NEW.instance_id
      AND json_extract(actor.value, '$.id') = NEW.actor_id
      AND (NEW.actor_id = 'lead' OR EXISTS (
        SELECT 1 FROM team_assignment_bindings b
        WHERE b.execution_id = e.id AND b.actor_id = NEW.actor_id
          AND b.task_id = json_extract(actor.value, '$.taskId')
      ))
  ) BEGIN
    SELECT RAISE(ABORT, 'Context actor must belong to its originating execution.');
  END;
  `,
  teamTaskMigration,
  /** Lead-owned task completions retain both requested intent and captured success. */
  `
  CREATE TABLE team_task_completion_intents (
    admission_id TEXT NOT NULL REFERENCES team_task_admissions(id) ON DELETE CASCADE,
    execution_id TEXT NOT NULL REFERENCES team_executions(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL CHECK(actor_id = 'lead'),
    attempt_id TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    PRIMARY KEY(admission_id, attempt_id)
  );
  CREATE INDEX team_task_completion_intents_attempt ON team_task_completion_intents(execution_id, attempt_id);
  CREATE TRIGGER team_task_initial_lead_assignee BEFORE INSERT ON team_task_admission_routes
  WHEN NEW.actor_id='lead' AND NEW.role='assignee' AND NEW.message_id IS NULL AND EXISTS (
    SELECT 1 FROM team_executions e, json_each(e.payload,'$.attempts') attempt
    WHERE e.id=NEW.execution_id AND json_extract(attempt.value,'$.actorId')='lead'
  ) BEGIN SELECT RAISE(ABORT,'A lead assignee route after reservation requires queued direction.'); END;
  CREATE TABLE team_task_completions (
    admission_id TEXT PRIMARY KEY REFERENCES team_task_admissions(id) ON DELETE CASCADE,
    execution_id TEXT NOT NULL REFERENCES team_executions(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL CHECK(actor_id = 'lead'),
    attempt_id TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    result TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    FOREIGN KEY(admission_id, attempt_id) REFERENCES team_task_completion_intents(admission_id, attempt_id) ON DELETE CASCADE
  );
  CREATE TRIGGER team_task_completion_intent_owner BEFORE INSERT ON team_task_completion_intents
  WHEN NOT EXISTS (
    SELECT 1 FROM team_task_admissions a JOIN team_task_admission_routes r ON r.admission_id=a.id
      JOIN team_executions e ON e.id=r.execution_id AND e.instance_id=a.instance_id,
      json_each(e.payload,'$.attempts') attempt
    WHERE a.id=NEW.admission_id AND r.execution_id=NEW.execution_id AND r.actor_id='lead' AND r.role='assignee'
      AND json_extract(attempt.value,'$.id')=NEW.attempt_id AND json_extract(attempt.value,'$.actorId')='lead'
  ) BEGIN SELECT RAISE(ABORT,'Task completion intent must belong to its lead assignment and attempt.'); END;
  CREATE TRIGGER team_task_completion_owner BEFORE INSERT ON team_task_completions
  WHEN NOT EXISTS (
    SELECT 1 FROM team_task_completion_intents i JOIN team_task_admissions a ON a.id=i.admission_id
      JOIN team_executions e ON e.id=i.execution_id JOIN runs run ON run.id=NEW.run_id
      JOIN snapshots s ON s.id=NEW.snapshot_id,
      json_each(e.payload,'$.attempts') attempt
    WHERE i.admission_id=NEW.admission_id AND i.attempt_id=NEW.attempt_id
      AND i.execution_id=NEW.execution_id AND i.actor_id=NEW.actor_id AND i.result=NEW.result
      AND json_extract(attempt.value,'$.id')=NEW.attempt_id AND json_extract(attempt.value,'$.actorId')='lead'
      AND json_extract(attempt.value,'$.runId')=run.id AND json_extract(attempt.value,'$.state')='closed'
      AND run.thread_id=e.thread_id AND run.task_id IS NULL AND run.state='success' AND run.ended_at IS NOT NULL
      AND s.task_id=a.task_id AND s.run_id=run.id
  ) BEGIN SELECT RAISE(ABORT,'Task completion must retain its successful lead run, intent, and task snapshot.'); END;
  ${["team_task_completion_intents", "team_task_completions"]
    .map(
      (table) => `
  CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table}
  BEGIN SELECT RAISE(ABORT,'Task completion history is immutable.'); END;
  CREATE TRIGGER ${table}_retained_delete BEFORE DELETE ON ${table}
  WHEN EXISTS (
    SELECT 1 FROM team_task_admissions a JOIN tasks t ON t.id=a.task_id
      JOIN orchestration_team_instances i ON i.id=a.instance_id
      JOIN threads h ON h.id=i.thread_id JOIN projects p ON p.id=h.project_id
    WHERE a.id=OLD.admission_id
  ) BEGIN SELECT RAISE(ABORT,'Task completion history is retained with its owner.'); END;
  `,
    )
    .join("")}
  CREATE TRIGGER team_task_completion_execution_retained BEFORE DELETE ON team_executions
  WHEN EXISTS (
    SELECT 1 FROM team_task_completion_intents c JOIN team_task_admissions a ON a.id=c.admission_id
      JOIN tasks t ON t.id=a.task_id JOIN orchestration_team_instances i ON i.id=a.instance_id
      JOIN threads h ON h.id=i.thread_id JOIN projects p ON p.id=h.project_id
    WHERE c.execution_id=OLD.id
  ) BEGIN SELECT RAISE(ABORT,'This execution is referenced by retained task completion history.'); END;
  CREATE TRIGGER team_task_completion_snapshot_retained BEFORE DELETE ON snapshots
  WHEN EXISTS (
    SELECT 1 FROM team_task_completions c JOIN team_task_admissions a ON a.id=c.admission_id
      JOIN tasks t ON t.id=a.task_id JOIN orchestration_team_instances i ON i.id=a.instance_id
      JOIN threads h ON h.id=i.thread_id JOIN projects p ON p.id=h.project_id
    WHERE c.snapshot_id=OLD.id
  ) BEGIN SELECT RAISE(ABORT,'This snapshot is referenced by retained task completion history.'); END;
  CREATE TRIGGER team_task_completion_run_retained BEFORE DELETE ON runs
  WHEN EXISTS (
    SELECT 1 FROM team_task_completion_intents c JOIN team_task_admissions a ON a.id=c.admission_id
      JOIN tasks t ON t.id=a.task_id JOIN orchestration_team_instances i ON i.id=a.instance_id
      JOIN threads h ON h.id=i.thread_id JOIN projects p ON p.id=h.project_id
      JOIN team_executions e ON e.id=c.execution_id, json_each(e.payload,'$.attempts') attempt
    WHERE json_extract(attempt.value,'$.id')=c.attempt_id AND json_extract(attempt.value,'$.runId')=OLD.id
  ) BEGIN SELECT RAISE(ABORT,'This run is referenced by retained task completion history.'); END;
  `,
  scheduleMigration,
  teamNotificationMigration,
  teamOriginMigration,
  teamForkMigration,
  teamRestoreMigration,
  teamForkRejectionMigration,
  teamMoveMigration,
  teamDeleteMigration,
  teamContextPartMigration,
  teamCleanupMigration,
  teamRoomMigration,
  teamDiscussionMigration,
  /** Mutable presentation preferences live outside immutable team revisions. */
  `
  CREATE TABLE orchestration_team_member_avatars (
    team_id TEXT NOT NULL REFERENCES orchestration_teams(id) ON DELETE CASCADE,
    member_key TEXT NOT NULL,
    default_index INTEGER NOT NULL CHECK(default_index >= 0),
    custom_path TEXT,
    updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
    PRIMARY KEY(team_id, member_key),
    CHECK(custom_path IS NULL OR length(custom_path) > 0)
  );
  `,
  teamLocalStartMigration,
  // Task board status is independent of execution state. Existing tasks keep
  // automatic progression until a user or agent explicitly moves them.
  `ALTER TABLE tasks ADD COLUMN status_is_explicit INTEGER NOT NULL DEFAULT 0 CHECK(status_is_explicit IN (0, 1));`,
  /** Conversation home remains stable while individual Workspace turns choose folders. */
  `ALTER TABLE threads ADD COLUMN working_directory TEXT;`,
  `ALTER TABLE runs ADD COLUMN working_directory TEXT;`,
  `CREATE TABLE thread_messages (
    id TEXT NOT NULL,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(thread_id, id)
  );
  CREATE INDEX thread_messages_order ON thread_messages(thread_id, created_at);`,
  `CREATE TABLE conversation_plans (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    text TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('draft','ready','interrupted')),
    source TEXT NOT NULL CHECK(source IN ('native','response')),
    updated_at INTEGER NOT NULL,
    UNIQUE(thread_id, revision)
  );
  CREATE INDEX conversation_plans_run ON conversation_plans(run_id, document_id, revision);
  CREATE TABLE conversation_plan_turns (run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE, started_at INTEGER NOT NULL, native_document INTEGER NOT NULL DEFAULT 0);`,
  `ALTER TABLE thread_messages ADD COLUMN attachments TEXT;`,
  taskCommentsMigration,
  teamHarnessMigration,
  /** Native rows are no longer written to the ledger; this finds the old ones as they expire, and empties with them. */
  `CREATE INDEX events_raw_ts ON events(ts) WHERE kind = 'raw';`,
  /** Where each turn ends, so a conversation can load its newest turns first. */
  `CREATE INDEX events_turns ON events(run_id, seq) WHERE kind = 'turn.completed';`,
  /** A restore saves the files around itself as labelled checkpoints, and a checkpoint remembers which folder it read. */
  `ALTER TABLE thread_checkpoints ADD COLUMN note TEXT;
  ALTER TABLE thread_checkpoints ADD COLUMN root TEXT;`,
  teamJournalMigration,
  /** A team conversation's view reads each execution's room messages on their own. */
  `CREATE INDEX team_room_events_execution ON team_room_events(instance_id, execution_id, seq);`,
  taskExecutionMigration,
  conversationReviewCommentsMigration,
  /** A review comment can cover a range of lines, as a pull request review does; one line leaves both empty. */
  `ALTER TABLE review_comments ADD COLUMN start_line INTEGER;
  ALTER TABLE review_comments ADD COLUMN start_side TEXT;`,
  teamCancellationMigration,
  /** Removing a project from navigation preserves its files and historical records. */
  `ALTER TABLE projects ADD COLUMN removed_at INTEGER;`,
  pullRequestReviewMigration,
  /** The branch a thread's worktree started from: its pull request targets it unless the user picks another. */
  `ALTER TABLE threads ADD COLUMN base_branch TEXT;`,
  /** A reviewing model's latest summary. It fills the draft's summary until the user writes their own, then waits beside it. */
  `ALTER TABLE pull_request_reviews ADD COLUMN model_summary TEXT;`,
  orclingMigration,
  /** The Orcling that drafted a pull request review comment, so the draft names it beside its model. */
  `ALTER TABLE pull_request_review_comments ADD COLUMN author_orcling_id TEXT REFERENCES orclings(id) ON DELETE SET NULL;`,
  /** The thread that started this one with thread_start. A parent counts its working children by it. */
  `ALTER TABLE threads ADD COLUMN parent_thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL;
  CREATE INDEX threads_parent ON threads(parent_thread_id) WHERE parent_thread_id IS NOT NULL;`,
];
