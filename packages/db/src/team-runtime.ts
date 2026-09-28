import {
  TEAM_ATTEMPT_TRANSITIONS,
  teamTransitionAllowed,
  TeamActorRecord,
  TeamAttemptRecord,
  TeamExecutionRecord,
  TeamFileClaim,
  TeamMailboxMessage,
  TeamPublicationRecord,
  TeamWorkspaceRecord,
  type TeamInstance,
  type TeamRevision,
  type TeamRunBinding,
} from "@openorc/protocol";
import type { z } from "zod";
import type { Db } from "./database.js";
import { orchestration } from "./orchestration.js";

export const MAX_TEAM_ATTEMPTS = 1_000;
export const MAX_TEAM_MESSAGES = 2_000;
export const MAX_TEAM_MAILBOX_BYTES = 2 * 1024 * 1024;

interface ExecutionRow {
  id: string;
  instance_id: string;
  thread_id: string;
  project_id: string;
  state: string;
  generation: number;
  revision: number;
  error: string | null;
  deadline_at: number;
  limits: string;
  admission_scope: string | null;
  admission_request_key: string | null;
  admission_payload_hash: string | null;
  row_version: number;
  created_at: number;
  updated_at: number;
}
interface ActorRow {
  id: string;
  member_key: string;
  task_id: string | null;
  parent_id: string | null;
  participant: number;
  state: string;
  details: string;
}
interface AttemptRow {
  id: string;
  actor_id: string;
  run_id: string | null;
  generation: number;
  state: string;
  snapshot_id: string | null;
  context_checkpoint_id: string | null;
  created_at: number;
  ended_at: number | null;
  details: string;
}
interface MessageRow {
  id: string;
  sequence: number;
  sender_id: string;
  recipient_id: string;
  kind: string;
  dedupe_key: string;
  state: string;
  attempt_id: string | null;
  body: string;
  created_at: number;
  details: string;
}
interface ClaimRow {
  id: string;
  actor_id: string;
  path: string;
  note: string | null;
  created_at: number;
  released_at: number | null;
}
interface BindingRow {
  run_id: string;
  execution_id: string;
  actor_id: string;
  attempt_id: string;
  generation: number;
}
interface AssignmentRow {
  task_id: string;
  execution_id: string;
  actor_id: string;
}
export interface TeamAssignmentBinding {
  taskId: string;
  executionId: string;
  actorId: string;
}

const terminal = (state: TeamExecutionRecord["state"]) => state === "completed" || state === "stopped";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function requireInvariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid team execution: ${message}`);
}
function unique(values: string[], label: string): void {
  requireInvariant(new Set(values).size === values.length, `${label} must be unique.`);
}
function runBinding(row: BindingRow): TeamRunBinding {
  return { runId: row.run_id, executionId: row.execution_id, actorId: row.actor_id, attemptId: row.attempt_id, generation: row.generation };
}
function binding(db: Db, runId: string): TeamRunBinding | null {
  const row = db.stmt("SELECT * FROM team_run_bindings WHERE run_id = ?").get(runId) as unknown as BindingRow | undefined;
  return row ? runBinding(row) : null;
}
function assignmentBinding(row: AssignmentRow): TeamAssignmentBinding {
  return { taskId: row.task_id, executionId: row.execution_id, actorId: row.actor_id };
}
function assignment(db: Db, executionId: string, actorId: string): TeamAssignmentBinding | null {
  const row = db.stmt("SELECT task_id, execution_id, actor_id FROM team_assignment_bindings WHERE execution_id = ? AND actor_id = ?").get(executionId, actorId) as unknown as AssignmentRow | undefined;
  return row ? assignmentBinding(row) : null;
}
function assignmentsForTask(db: Db, taskId: string): TeamAssignmentBinding[] {
  // rowid is binding_order after v12, and also reads fixed pre-v12 fixtures.
  return (db.stmt("SELECT task_id, execution_id, actor_id FROM team_assignment_bindings WHERE task_id = ? ORDER BY rowid").all(taskId) as unknown as AssignmentRow[]).map(assignmentBinding);
}
function assignmentForTask(db: Db, taskId: string): { executionId: string; actorId: string } | null {
  const rows = db
    .stmt(
      `SELECT b.task_id, b.execution_id, b.actor_id, actor.state AS actor_state
    FROM team_assignment_bindings b LEFT JOIN team_actors actor ON actor.execution_id = b.execution_id AND actor.id = b.actor_id
    WHERE b.task_id = ? ORDER BY b.rowid`,
    )
    .all(taskId) as unknown as (AssignmentRow & { actor_state: TeamActorRecord["state"] | null })[];
  requireInvariant(
    rows.every((row) => row.actor_state !== null),
    `task ${taskId} has a binding without its retained actor.`,
  );
  const active = rows.filter((row) => row.actor_state !== "completed" && row.actor_state !== "cancelled");
  requireInvariant(active.length <= 1, `task ${taskId} has multiple active assignment reservations.`);
  const row = active[0] ?? rows.at(-1);
  return row ? { executionId: row.execution_id, actorId: row.actor_id } : null;
}

/**
 * One journal entity per row: the columns that queries, constraints and triggers read, then its remaining fields
 * as JSON details. Position keeps the journal's append order, which history never rewrites.
 */
interface Table<T> {
  name: string;
  columns: readonly string[];
  values(item: T, position: number): (string | number | null)[];
}
const actorTable: Table<TeamActorRecord> = {
  name: "team_actors",
  columns: ["id", "position", "member_key", "task_id", "parent_id", "participant", "state", "details"],
  values: ({ id, memberKey, taskId, parentId, participant, state, ...details }, position) => [id, position, memberKey, taskId, parentId, participant ? 1 : 0, state, JSON.stringify(details)],
};
const attemptTable: Table<TeamAttemptRecord> = {
  name: "team_attempts",
  columns: ["id", "position", "actor_id", "run_id", "generation", "state", "snapshot_id", "context_checkpoint_id", "created_at", "ended_at", "details"],
  values: ({ id, actorId, runId, generation, state, snapshotId, contextCheckpointId, createdAt, endedAt, ...details }, position) => [
    id,
    position,
    actorId,
    runId,
    generation,
    state,
    snapshotId,
    contextCheckpointId ?? null,
    createdAt,
    endedAt,
    JSON.stringify(details),
  ],
};
const messageTable: Table<TeamMailboxMessage> = {
  name: "team_messages",
  columns: ["id", "sequence", "sender_id", "recipient_id", "kind", "dedupe_key", "state", "attempt_id", "body", "created_at", "details"],
  values: ({ id, sequence, senderId, recipientId, kind, dedupeKey, state, attemptId, body, createdAt, ...details }) => [
    id,
    sequence,
    senderId,
    recipientId,
    kind,
    dedupeKey,
    state,
    attemptId,
    body,
    createdAt,
    JSON.stringify(details),
  ],
};
const claimTable: Table<TeamFileClaim> = {
  name: "team_claims",
  columns: ["id", "position", "actor_id", "path", "note", "created_at", "released_at"],
  values: ({ id, actorId, path, note, createdAt, releasedAt }, position) => [id, position, actorId, path, note, createdAt, releasedAt],
};

function decodeActor(row: ActorRow): unknown {
  return { id: row.id, memberKey: row.member_key, taskId: row.task_id, parentId: row.parent_id, ...(row.participant ? { participant: true } : {}), state: row.state, ...JSON.parse(row.details) };
}
function decodeAttempt(row: AttemptRow): unknown {
  return {
    id: row.id,
    actorId: row.actor_id,
    runId: row.run_id,
    generation: row.generation,
    state: row.state,
    snapshotId: row.snapshot_id,
    ...(row.context_checkpoint_id === null ? {} : { contextCheckpointId: row.context_checkpoint_id }),
    createdAt: row.created_at,
    endedAt: row.ended_at,
    ...JSON.parse(row.details),
  };
}
function decodeMessage(row: MessageRow): unknown {
  return {
    id: row.id,
    sequence: row.sequence,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    kind: row.kind,
    dedupeKey: row.dedupe_key,
    state: row.state,
    attemptId: row.attempt_id,
    body: row.body,
    createdAt: row.created_at,
    ...JSON.parse(row.details),
  };
}
function decodeClaim(row: ClaimRow): unknown {
  return { id: row.id, actorId: row.actor_id, path: row.path, note: row.note, createdAt: row.created_at, releasedAt: row.released_at };
}

function unreadable(id: string, error: unknown): Error {
  return new Error(
    `Team execution ${id} could not be read. Its journal is invalid; preserve the database and inspect this execution before retrying. ${error instanceof Error ? error.message : String(error)}`,
  );
}

/** Reading only checks structure: what was written was validated then, and later changes elsewhere cannot make it unreadable. */
function load(db: Db, row: ExecutionRow): TeamExecutionRecord {
  try {
    const rows = <T>(table: string, order: string) => db.stmt(`SELECT * FROM ${table} WHERE execution_id = ? ORDER BY ${order}`).all(row.id) as unknown as T[];
    const claims = rows<ClaimRow>("team_claims", "position").map(decodeClaim);
    return TeamExecutionRecord.parse({
      id: row.id,
      instanceId: row.instance_id,
      threadId: row.thread_id,
      projectId: row.project_id,
      ...(row.admission_scope === null ? {} : { admission: { scope: row.admission_scope, requestKey: row.admission_request_key, payloadHash: row.admission_payload_hash } }),
      state: row.state,
      generation: row.generation,
      revision: row.revision,
      limits: JSON.parse(row.limits),
      actors: rows<ActorRow>("team_actors", "position").map(decodeActor),
      attempts: rows<AttemptRow>("team_attempts", "position").map(decodeAttempt),
      messages: rows<MessageRow>("team_messages", "sequence").map(decodeMessage),
      ...(claims.length ? { claims } : {}),
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deadlineAt: row.deadline_at,
    });
  } catch (error) {
    throw unreadable(row.id, error);
  }
}

/** Each entry's canonical JSON by id, per kind, so a write can tell exactly which entries it changed. */
interface Entries {
  actors: Map<string, string>;
  attempts: Map<string, string>;
  messages: Map<string, string>;
  claims: Map<string, string>;
}
const KINDS = ["actors", "attempts", "messages", "claims"] as const;
function entriesOf(record: TeamExecutionRecord): Entries {
  const serialize = (items: readonly { id: string }[]) => new Map(items.map((item) => [item.id, JSON.stringify(item)]));
  return { actors: serialize(record.actors), attempts: serialize(record.attempts), messages: serialize(record.messages), claims: serialize(record.claims ?? []) };
}

/**
 * A journal as last read or written: shared by the cache and never changed. Every read compares the whole execution
 * row, whose row_version advances with any change to the execution's entries, and a rolled-back transaction drops
 * the cache, so a snapshot can never outlive the rows it came from, whoever changed them.
 */
interface Snapshot {
  row: string;
  record: TeamExecutionRecord;
  entries: Entries;
}
const caches = new WeakMap<Db, Map<string, Snapshot>>();
function cacheFor(db: Db): Map<string, Snapshot> {
  let cache = caches.get(db);
  if (!cache) {
    const created = new Map<string, Snapshot>();
    db.onRollback(() => created.clear());
    caches.set(db, created);
    cache = created;
  }
  return cache;
}

function executionRow(db: Db, id: string): ExecutionRow | undefined {
  return db.stmt("SELECT * FROM team_executions WHERE id = ?").get(id) as unknown as ExecutionRow | undefined;
}
function snapshot(db: Db, id: string): Snapshot | null {
  const cache = cacheFor(db);
  const row = executionRow(db, id);
  if (!row) {
    cache.delete(id);
    return null;
  }
  const key = JSON.stringify(row);
  const cached = cache.get(id);
  if (cached?.row === key) return cached;
  const record = load(db, row);
  const loaded = { row: key, record, entries: entriesOf(record) };
  cache.set(id, loaded);
  return loaded;
}
/** The current journal, shared with the cache: read it, never change it. Callers outside this module get copies. */
function current(db: Db, id: string): TeamExecutionRecord | null {
  return snapshot(db, id)?.record ?? null;
}
/** Keeps its own copy of what was just written: the caller's record and value may share entries with its draft. */
function remember(db: Db, record: TeamExecutionRecord, entries: Entries): void {
  cacheFor(db).set(record.id, { row: JSON.stringify(executionRow(db, record.id)), record: structuredClone(record), entries });
}

/** Durable evidence only; the coordinator must also await actual process/setup leases. */
function assertAssignmentReleased(db: Db, record: TeamExecutionRecord, actor: TeamActorRecord): void {
  const subtree = new Set([actor.id]);
  for (let size = 0; size !== subtree.size;) {
    size = subtree.size;
    for (const child of record.actors) if (child.parentId && subtree.has(child.parentId)) subtree.add(child.id);
  }
  for (const member of record.actors.filter((item) => subtree.has(item.id))) {
    requireInvariant(member.state === "completed" || member.state === "cancelled", `task ${actor.taskId} still has an active assignment or descendant.`);
    for (const attempt of record.attempts.filter((item) => item.actorId === member.id)) {
      requireInvariant(!["starting", "running"].includes(attempt.state) && attempt.endedAt !== null, `task ${actor.taskId} has an attempt that has not finished closing.`);
      if (attempt.runId) {
        const run = db.stmt("SELECT state, ended_at FROM runs WHERE id = ?").get(attempt.runId) as { state: string; ended_at: number | null } | undefined;
        requireInvariant(run && ["success", "error", "cancelled"].includes(run.state) && run.ended_at !== null, `task ${actor.taskId} has a run that has not finished closing.`);
      }
    }
    const workspaceRow = db.stmt("SELECT payload FROM team_workspaces WHERE execution_id = ? AND actor_id = ?").get(record.id, member.id) as { payload: string } | undefined;
    if (workspaceRow) {
      const workspace = TeamWorkspaceRecord.parse(JSON.parse(workspaceRow.payload));
      requireInvariant(workspace.executionId === record.id && workspace.actorId === member.id && workspace.taskId === member.taskId, `task ${actor.taskId} workspace ownership does not match.`);
      requireInvariant(workspace.state === "ready" && workspace.setupState === "completed", `task ${actor.taskId} workspace preparation still needs recovery.`);
      if (workspace.outputTree && member.state === "completed") {
        const applied = db
          .stmt("SELECT 1 FROM team_publications WHERE execution_id = ? AND source_actor_id = ? AND output_tree = ? AND json_extract(payload, '$.state') = 'applied'")
          .get(record.id, member.id, workspace.outputTree);
        requireInvariant(applied, `task ${actor.taskId} has captured output that has not been integrated.`);
      }
    }
  }
  const publications = db.stmt("SELECT payload FROM team_publications WHERE execution_id = ?").all(record.id) as { payload: string }[];
  for (const row of publications) {
    const publication = TeamPublicationRecord.parse(JSON.parse(row.payload));
    if (subtree.has(publication.sourceActorId) || subtree.has(publication.targetActorId) || publication.includedActorIds.some((id) => subtree.has(id)))
      requireInvariant(publication.state === "applied", `task ${actor.taskId} has publication recovery that must finish before reuse.`);
  }
}

function validateTaskHistory(db: Db, proposed: TeamExecutionRecord, taskId: string): void {
  const rows = db.stmt("SELECT execution_id, actor_id FROM team_assignment_bindings WHERE task_id = ? ORDER BY rowid").all(taskId) as { execution_id: string; actor_id: string }[];
  const owners = rows.map((row) => {
    const record = row.execution_id === proposed.id ? proposed : current(db, row.execution_id);
    const actor = record?.actors.find((item) => item.id === row.actor_id);
    requireInvariant(record && actor?.taskId === taskId, `task ${taskId} has an invalid retained assignment binding.`);
    return { record, actor };
  });
  for (const actor of proposed.actors.filter((item) => item.taskId === taskId)) {
    if (!owners.some((owner) => owner.record.id === proposed.id && owner.actor.id === actor.id)) owners.push({ record: proposed, actor });
  }
  const first = owners[0]!;
  const parent = (record: TeamExecutionRecord, actor: TeamActorRecord) => {
    const owner = record.actors.find((item) => item.id === actor.parentId);
    requireInvariant(owner, `task ${taskId} has an assignment without its retained parent.`);
    return owner.taskId;
  };
  for (let index = 1; index < owners.length; index++) {
    const next = owners[index]!;
    requireInvariant(
      next.record.instanceId === first.record.instanceId &&
        next.record.threadId === first.record.threadId &&
        next.record.projectId === first.record.projectId &&
        next.actor.memberKey === first.actor.memberKey &&
        parent(next.record, next.actor) === parent(first.record, first.actor),
      `task ${taskId} follow-up must retain its instance, member, and parent task provenance.`,
    );
    assertAssignmentReleased(db, owners[index - 1]!.record, owners[index - 1]!.actor);
  }
}

function validateJournalLimits(record: TeamExecutionRecord): void {
  requireInvariant(record.updatedAt >= record.createdAt && record.deadlineAt >= record.createdAt, "execution timestamps are out of order.");
  requireInvariant(record.actors.filter((actor) => !actor.participant).length <= record.limits.maxAssignments + 1, "assignment limit exceeded.");
  requireInvariant(record.attempts.length <= MAX_TEAM_ATTEMPTS, `at most ${MAX_TEAM_ATTEMPTS} attempts may be retained.`);
  requireInvariant(record.messages.length <= MAX_TEAM_MESSAGES, `at most ${MAX_TEAM_MESSAGES} mailbox messages may be retained.`);
  requireInvariant(
    record.messages.reduce((bytes, message) => bytes + Buffer.byteLength(message.body, "utf8") + (message.attachments ?? []).reduce((total, file) => total + Buffer.byteLength(file, "utf8"), 0), 0) <=
      MAX_TEAM_MAILBOX_BYTES,
    "mailbox text and image references exceed 2 MiB.",
  );
}

function validateActorGraph(record: TeamExecutionRecord): Map<string, TeamActorRecord> {
  unique(
    record.actors.map((actor) => actor.id),
    "Actor IDs",
  );
  unique(
    record.actors.filter((actor) => !actor.participant && actor.state !== "completed" && actor.state !== "cancelled").map((actor) => actor.memberKey),
    "Active members",
  );
  unique(
    record.actors.filter((actor) => actor.participant).map((actor) => actor.memberKey),
    "Participants",
  );
  unique(
    record.actors.filter((actor) => actor.state !== "completed" && actor.state !== "cancelled").flatMap((actor) => (actor.taskId ? [actor.taskId] : [])),
    "Active actor tasks",
  );
  unique(
    record.actors.flatMap((actor) => (actor.requestKey === null ? [] : [JSON.stringify([actor.parentId, actor.requestKey])])),
    "Parent-scoped dispatch request keys",
  );
  const actors = new Map(record.actors.map((actor) => [actor.id, actor]));
  const lead = actors.get("lead");
  requireInvariant(lead && lead.parentId === null && lead.taskId === null && lead.requestKey === null && lead.requestHash === null, "exactly one lead actor with ID 'lead' and no task is required.");
  for (const actor of record.actors) {
    requireInvariant(actor.retries < record.limits.maxAttemptsPerAssignment, `actor ${actor.id} exceeds its retry limit.`);
    requireInvariant(actor.deliveredVersion <= actor.directionVersion, `actor ${actor.id} delivered a future direction.`);
    requireInvariant(actor.modeHold === undefined || actor.id === "lead", `actor ${actor.id} mode hold is reserved for the lead.`);
    if (actor.participant) {
      const parent = actor.parentId === null ? undefined : actors.get(actor.parentId);
      requireInvariant(
        actor.id === `member:${actor.memberKey}` && parent && actor.taskId === null && actor.requestKey === null && actor.requestHash === null && actor.dependencies.length === 0,
        `participant ${actor.id} needs its member identity, its manager and no task.`,
      );
    } else if (actor.id !== "lead") {
      const parent = actor.parentId === null ? undefined : actors.get(actor.parentId);
      requireInvariant(parent && actor.taskId !== null && actor.requestKey !== null && actor.requestHash !== null, `actor ${actor.id} requires its assigned manager, task, and dispatch identity.`);
    }
    unique(actor.dependencies, `Dependencies for ${actor.id}`);
    for (const dependency of actor.dependencies) {
      const target = actors.get(dependency);
      requireInvariant(target && target.id !== actor.id && target.parentId === actor.parentId, `actor ${actor.id} has an invalid sibling dependency.`);
    }
    for (const target of actor.disposition?.waitFor ?? []) requireInvariant(actors.get(target)?.parentId === actor.id, `actor ${actor.id} may only wait for its own direct children.`);
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    requireInvariant(!visiting.has(id), "actor dependencies contain a cycle.");
    visiting.add(id);
    for (const dependency of actors.get(id)!.dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const actor of record.actors) visit(actor.id);
  return actors;
}

function validateProcessSharing(record: TeamExecutionRecord, actors: Map<string, TeamActorRecord>): void {
  unique(
    record.attempts.map((attempt) => attempt.id),
    "Attempt IDs",
  );
  // A provider process may serve several turns of one conversation member, so a run id can repeat across attempts.
  // What it may never do is cross an actor, a generation, or the settings and context the process was spawned with,
  // and only the newest turn on a process may still be open. The lead and isolated assignments keep one run per turn:
  // fork, move, restore and task completion resolve the lead's turn through its binding in SQL.
  const sharing = new Map<string, TeamAttemptRecord[]>();
  for (const attempt of record.attempts) if (attempt.runId !== null) sharing.set(attempt.runId, [...(sharing.get(attempt.runId) ?? []), attempt]);
  for (const [runId, turns] of sharing) {
    if (turns.length === 1) continue;
    const owner = turns[0]!;
    requireInvariant(actors.get(owner.actorId)?.participant === true, `run ${runId} is shared by turns of ${owner.actorId}, which is not a conversation member.`);
    for (const attempt of turns)
      requireInvariant(
        attempt.actorId === owner.actorId &&
          attempt.generation === owner.generation &&
          attempt.mode === owner.mode &&
          attempt.configurationVersion === owner.configurationVersion &&
          attempt.contextCheckpointId === owner.contextCheckpointId &&
          same(attempt.settings, owner.settings),
        `run ${runId} is shared by turns that could not have started from one process.`,
      );
    for (const attempt of turns.slice(0, -1)) requireInvariant(attempt.state === "closed" && attempt.endedAt !== null, `run ${runId} began another turn before turn ${attempt.id} closed.`);
  }
}

function validateAttemptReservations(record: TeamExecutionRecord, actors: Map<string, TeamActorRecord>): Map<string, TeamAttemptRecord> {
  const attempts = new Map(record.attempts.map((attempt) => [attempt.id, attempt]));
  const messages = new Map(record.messages.map((message) => [message.id, message]));
  for (const actor of record.actors)
    requireInvariant(actor.dispatchedBy === undefined || attempts.get(actor.dispatchedBy)?.actorId === actor.parentId, `actor ${actor.id} must be delegated by a turn of its manager.`);
  for (const attempt of record.attempts) {
    const actor = actors.get(attempt.actorId);
    requireInvariant(actor && attempt.generation <= record.generation, `attempt ${attempt.id} has an unknown actor or future generation.`);
    requireInvariant(attempt.directionVersion <= actor.directionVersion, `attempt ${attempt.id} references a future direction.`);
    unique(attempt.messageIds, `Mailbox claims for ${attempt.id}`);
    for (const id of attempt.messageIds) requireInvariant(messages.get(id)?.recipientId === actor.id, `attempt ${attempt.id} claims another actor's message.`);
    const liveDirections = attempt.liveDirections ?? [];
    unique(
      liveDirections.map((item) => item.messageId),
      `Live direction reservations for ${attempt.id}`,
    );
    requireInvariant(liveDirections.length === 0 || attempt.runId !== null, `attempt ${attempt.id} live direction requires its bound run.`);
    for (let index = 0; index < liveDirections.length; index++) {
      const delivery = liveDirections[index]!;
      const message = messages.get(delivery.messageId);
      requireInvariant(message?.recipientId === actor.id, `attempt ${attempt.id} live delivery requires a message to this actor.`);
      requireInvariant(!attempt.messageIds.includes(delivery.messageId), `attempt ${attempt.id} live direction duplicates its initial input.`);
      requireInvariant(delivery.createdAt >= attempt.createdAt && delivery.createdAt >= message.createdAt, `attempt ${attempt.id} live reservation predates its input.`);
      requireInvariant(
        delivery.directionVersion > attempt.directionVersion && delivery.directionVersion <= actor.directionVersion,
        `attempt ${attempt.id} live direction references an invalid direction version.`,
      );
      const previous = liveDirections[index - 1];
      if (previous)
        requireInvariant(
          previous.directionVersion < delivery.directionVersion && previous.createdAt <= delivery.createdAt && messages.get(previous.messageId)!.sequence < message.sequence,
          `attempt ${attempt.id} live direction order must be retained.`,
        );
    }
  }
  return attempts;
}

function validateMailbox(record: TeamExecutionRecord, actors: Map<string, TeamActorRecord>, attempts: Map<string, TeamAttemptRecord>): void {
  unique(
    record.messages.map((message) => message.id),
    "Mailbox message IDs",
  );
  unique(
    record.messages.map((message) => String(message.sequence)),
    "Mailbox sequences",
  );
  unique(
    record.messages.map((message) => message.dedupeKey),
    "Mailbox dedupe keys",
  );
  for (const message of record.messages) {
    requireInvariant(
      (message.senderId === "user" || message.senderId.startsWith("thread:") || actors.has(message.senderId)) && actors.has(message.recipientId),
      `message ${message.id} has an unknown sender or recipient.`,
    );
    requireInvariant(
      !message.senderId.startsWith("thread:") || (message.recipientId === "lead" && message.kind === "direction"),
      `message ${message.id} from another thread must be direction to the lead.`,
    );
    requireInvariant(
      message.delivery === undefined ||
        message.kind === "chat" ||
        (message.kind === "direction" &&
          (message.senderId === "user" || actors.get(message.senderId)?.parentId === message.recipientId || actors.get(message.recipientId)?.parentId === message.senderId)),
      `message ${message.id} immediate delivery requires chat, user direction, or direction within the assignment hierarchy.`,
    );
    requireInvariant(
      (message.chatId === undefined && message.to === undefined) || (message.kind === "chat" && message.chatId !== undefined && message.to !== undefined && message.to.includes(message.recipientId)),
      `message ${message.id} chat identity requires the chat kind and lists its own recipient.`,
    );
    requireInvariant((message.state === "cancelled") === (message.cancelledAt !== undefined), `message ${message.id} cancellation requires its terminal state and timestamp together.`);
    if (message.state === "cancelled") {
      requireInvariant(
        message.senderId === "user" && message.kind === "direction" && message.attemptId === null && message.deliveredAt === null,
        `message ${message.id} cancellation requires an unclaimed user direction.`,
      );
      requireInvariant(message.cancelledAt! >= message.createdAt, `message ${message.id} cancellation predates its creation.`);
      requireInvariant(
        !record.attempts.some((attempt) => attempt.messageIds.includes(message.id) || attempt.liveDirections?.some((item) => item.messageId === message.id)),
        `message ${message.id} was already reserved and cannot be cancelled.`,
      );
    }
    if (message.attemptId !== null) {
      const attempt = attempts.get(message.attemptId);
      const delivery = attempt?.liveDirections?.find((item) => item.messageId === message.id);
      requireInvariant(
        attempt?.actorId === message.recipientId &&
          (attempt.messageIds.includes(message.id) || (delivery !== undefined && delivery.state !== "unavailable" && (message.state !== "delivered" || delivery.state === "accepted"))),
        `message ${message.id} has an invalid delivery attempt.`,
      );
    }
  }
}

function validateFileClaims(record: TeamExecutionRecord, actors: Map<string, TeamActorRecord>): void {
  unique(
    (record.claims ?? []).map((claim) => claim.id),
    "Claim IDs",
  );
  unique(
    (record.claims ?? []).filter((claim) => claim.releasedAt === null).map((claim) => claim.path),
    "Active file claims",
  );
  for (const claim of record.claims ?? []) {
    requireInvariant(actors.has(claim.actorId), `claim ${claim.id} belongs to an unknown actor.`);
    requireInvariant(claim.releasedAt === null || claim.releasedAt >= claim.createdAt, `claim ${claim.id} was released before it was made.`);
  }
}

/** Everything a journal must satisfy on its own, checked in memory on every write. */
function validateJournal(record: TeamExecutionRecord): void {
  validateJournalLimits(record);
  const actors = validateActorGraph(record);
  validateProcessSharing(record, actors);
  const attempts = validateAttemptReservations(record, actors);
  validateMailbox(record, actors, attempts);
  validateFileClaims(record, actors);
}

/**
 * What a write must prove against the rest of the database, for the entries it adds or changes. Entries written
 * earlier were proven then; rechecking them would let a later, unrelated change elsewhere block every future write.
 */
function validateReferences(db: Db, before: TeamExecutionRecord | null, record: TeamExecutionRecord): void {
  let pinned: { instance: TeamInstance; revision: TeamRevision } | null = null;
  const team = () => {
    if (pinned) return pinned;
    const instance = orchestration.getInstance(db, record.threadId);
    requireInvariant(instance?.id === record.instanceId, "instance, thread, and project ownership do not match.");
    const revision = orchestration.getRevision(db, instance.teamRevisionId);
    requireInvariant(revision?.projectId === record.projectId, "the pinned team revision is missing or belongs to another project.");
    pinned = { instance, revision };
    return pinned;
  };
  if (!before) {
    const { revision } = team();
    const thread = db.stmt("SELECT project_id FROM threads WHERE id = ?").get(record.threadId) as { project_id: string } | undefined;
    requireInvariant(thread?.project_id === record.projectId, "instance, thread, and project ownership do not match.");
    requireInvariant(same(record.limits, revision.limits), "limits must match the pinned team revision.");
  }
  const actors = new Map(record.actors.map((actor) => [actor.id, actor]));
  const knownActors = new Set(before?.actors.map((actor) => actor.id));
  const added = record.actors.filter((actor) => !knownActors.has(actor.id));
  if (added.length) {
    const { instance, revision } = team();
    const members = new Map(revision.members.map((member) => [member.key, member]));
    for (const actor of added) {
      const member = members.get(actor.memberKey);
      requireInvariant(member && instance.members.some((identity) => identity.memberKey === actor.memberKey), `actor ${actor.id} is not a pinned team member.`);
      if (actor.id === "lead") {
        requireInvariant(member.managerKey === null, "exactly one lead actor with ID 'lead' and no task is required.");
        continue;
      }
      const parent = actors.get(actor.parentId!)!;
      if (actor.participant) {
        requireInvariant(member.managerKey === parent.memberKey, `participant ${actor.id} needs its member identity, its manager and no task.`);
        continue;
      }
      requireInvariant(member.managerKey === parent.memberKey, `actor ${actor.id} requires its assigned manager, task, and dispatch identity.`);
      const task = db.stmt("SELECT project_id, thread_id, parent_task_id FROM tasks WHERE id = ?").get(actor.taskId) as
        { project_id: string; thread_id: string | null; parent_task_id: string | null } | undefined;
      requireInvariant(task?.project_id === record.projectId && task.thread_id === record.threadId, `actor ${actor.id} task is outside this execution's thread or project.`);
      requireInvariant(task.parent_task_id === parent.taskId, `actor ${actor.id} task must retain its requesting manager's task as parent.`);
    }
    for (const taskId of new Set(added.flatMap((actor) => (actor.taskId ? [actor.taskId] : [])))) validateTaskHistory(db, record, taskId);
  }

  const previousAttempts = new Map(before?.attempts.map((attempt) => [attempt.id, attempt]));
  record.attempts.forEach((attempt, index) => {
    const previous = previousAttempts.get(attempt.id);
    const actor = actors.get(attempt.actorId)!;
    if (!previous) {
      requireInvariant(attempt.configurationVersion <= team().instance.configurationVersion, `attempt ${attempt.id} references a future configuration.`);
      if (attempt.contextCheckpointId !== undefined) {
        const checkpoint = db.stmt("SELECT instance_id, execution_id, actor_id FROM team_context_checkpoints WHERE id = ?").get(attempt.contextCheckpointId) as
          { instance_id: string; execution_id: string | null; actor_id: string } | undefined;
        requireInvariant(
          checkpoint && checkpoint.instance_id === record.instanceId && checkpoint.actor_id === actor.id && checkpoint.execution_id === (actor.id === "lead" ? null : record.id),
          `attempt ${attempt.id} context checkpoint belongs to another actor or instance.`,
        );
      }
      const reservedSession = attempt.contextSessionId ?? attempt.resumeSessionId;
      if (reservedSession != null) {
        // The lead and participants keep thread sessions across executions; assignments resume only their own task run.
        const conversationMember = actor.id === "lead" || actor.participant ? 1 : 0;
        const source = db
          .stmt(
            `SELECT 1 FROM runs r
            JOIN team_run_bindings b ON b.run_id = r.id
            JOIN team_executions e ON e.id = b.execution_id
            JOIN team_attempts previous ON previous.execution_id = e.id AND previous.id = b.attempt_id
            WHERE r.external_session_id = ? AND r.agent = ? AND e.instance_id = ? AND b.actor_id = ?
              AND (? OR e.id = ?)
              AND previous.run_id = r.id
              AND previous.actor_id = b.actor_id
              AND previous.context_checkpoint_id IS ?
              AND previous.id <> ?
              AND previous.created_at <= ?
              AND e.created_at <= ?
              AND (e.id <> ? OR previous.position < ?)
              AND ((? AND r.thread_id = ? AND r.task_id IS NULL)
                OR (NOT ? AND r.task_id = ? AND r.thread_id IS NULL)) LIMIT 1`,
          )
          .get(
            reservedSession,
            attempt.settings.agent,
            record.instanceId,
            actor.id,
            conversationMember,
            record.id,
            attempt.contextCheckpointId ?? null,
            attempt.id,
            attempt.createdAt,
            record.createdAt,
            record.id,
            index,
            conversationMember,
            record.threadId,
            conversationMember,
            actor.taskId,
          );
        requireInvariant(source, `attempt ${attempt.id} ${attempt.contextCheckpointId ? "context session" : "reserved session"} has no prior established run in its own actor and checkpoint scope.`);
      }
    }
    if (attempt.runId !== null && previous?.runId !== attempt.runId) {
      const run = db.stmt("SELECT task_id, thread_id, mode FROM runs WHERE id = ?").get(attempt.runId) as { task_id: string | null; thread_id: string | null; mode: string } | undefined;
      requireInvariant(
        run && (actor.id === "lead" || actor.participant ? run.thread_id === record.threadId && run.task_id === null : run.task_id === actor.taskId && run.thread_id === null),
        `attempt ${attempt.id} run belongs to another task or thread.`,
      );
      requireInvariant(attempt.mode === undefined || run.mode === attempt.mode, `attempt ${attempt.id} run mode differs from its reservation.`);
    }
  });

  const previousMessages = new Map(before?.messages.map((message) => [message.id, message]));
  const attempts = new Map(record.attempts.map((attempt) => [attempt.id, attempt]));
  for (const message of record.messages) {
    if (message.state !== "delivered" || previousMessages.get(message.id)?.state === "delivered" || message.attemptId === null) continue;
    const attempt = attempts.get(message.attemptId)!;
    if (!attempt.liveDirections?.some((item) => item.messageId === message.id)) continue;
    const run = attempt.runId ? (db.stmt("SELECT state, ended_at FROM runs WHERE id = ?").get(attempt.runId) as { state: string; ended_at: number | null } | undefined) : undefined;
    const recipient = actors.get(message.recipientId);
    // A conversation turn closes only once the coordinator accepted it: captured, or a chat or ambient turn that
    // needed no snapshot. Its process can outlive the turn and end later for its own reasons (a later turn, Stop,
    // crash recovery), so the closed attempt is the evidence. An isolated assignment's process ends with its turn.
    const conversation = recipient?.id === "lead" || recipient?.participant === true;
    requireInvariant(
      attempt.state === "closed" &&
        attempt.endedAt !== null &&
        message.deliveredAt !== null &&
        (conversation ? run !== undefined : attempt.error === null && attempt.snapshotId !== null && run?.state === "success" && run.ended_at !== null),
      `message ${message.id} live delivery requires a successfully captured and closed attempt.`,
    );
  }
}

/** History only grows: entries keep their place and identity, and what is settled stays settled. Unchanged entries hold trivially. */
function immutableHistory(before: TeamExecutionRecord, after: TeamExecutionRecord, changes: Changes): void {
  for (const key of ["id", "instanceId", "threadId", "projectId", "admission", "createdAt", "deadlineAt", "limits", "revision", "updatedAt"] as const) {
    requireInvariant(same(before[key], after[key]), `${key} cannot be changed by an update callback.`);
  }
  requireInvariant(after.generation >= before.generation, "execution generation cannot move backwards.");
  requireInvariant(!terminal(before.state) || after.state === before.state, "a terminal execution cannot be reopened.");
  const appendOnly = (label: string, previous: readonly { id: string }[], next: readonly { id: string }[]) => {
    const kept = new Set(next.map((item) => item.id));
    for (const item of previous) requireInvariant(kept.has(item.id), `${label} ${item.id} cannot be removed from history.`);
    previous.forEach((item, index) => requireInvariant(next[index]?.id === item.id, `${label} ${item.id} must keep its place in history.`));
  };
  appendOnly("actor", before.actors, after.actors);
  appendOnly("claim", before.claims ?? [], after.claims ?? []);
  appendOnly("attempt", before.attempts, after.attempts);
  appendOnly("message", before.messages, after.messages);
  for (let index = 1; index < after.messages.length; index++)
    requireInvariant(after.messages[index - 1]!.sequence < after.messages[index]!.sequence, `message ${after.messages[index]!.id} must follow earlier mailbox sequences.`);

  before.actors.forEach((actor, index) => {
    if (!changes.actors.has(actor.id)) return;
    const next = after.actors[index]!;
    for (const key of ["memberKey", "taskId", "parentId", "requestKey", "requestHash", "dependencies", "input", "participant", "dispatchedBy"] as const)
      requireInvariant(same(actor[key], next[key]), `actor ${actor.id} ${key} is immutable.`);
    requireInvariant(next.directionVersion >= actor.directionVersion && next.retries >= actor.retries, `actor ${actor.id} versions and retries cannot move backwards.`);
  });
  (before.claims ?? []).forEach((claim, index) => {
    if (!changes.claims.has(claim.id)) return;
    const next = after.claims![index]!;
    for (const key of ["actorId", "path", "note", "createdAt"] as const) requireInvariant(same(claim[key], next[key]), `claim ${claim.id} ${key} is immutable.`);
    requireInvariant(claim.releasedAt === null || same(claim.releasedAt, next.releasedAt), `claim ${claim.id} release is immutable.`);
  });
  const messages = new Map(after.messages.map((message) => [message.id, message]));
  const latestAttempt = new Map(after.attempts.map((attempt) => [attempt.actorId, attempt.id]));
  before.attempts.forEach((attempt, index) => {
    if (!changes.attempts.has(attempt.id)) return;
    const next = after.attempts[index]!;
    // A turn is history once settled: whatever writes the journal, a closed or cancelled turn never changes state.
    requireInvariant(teamTransitionAllowed(TEAM_ATTEMPT_TRANSITIONS, attempt.state, next.state), `attempt ${attempt.id} cannot move from ${attempt.state} to ${next.state}.`);
    for (const key of [
      "actorId",
      "generation",
      "mode",
      "settings",
      "configurationVersion",
      "directionVersion",
      "messageIds",
      "attachments",
      "createdAt",
      "contextCheckpointId",
      "contextSeed",
      "contextSessionId",
      "resumeSessionId",
    ] as const)
      requireInvariant(same(attempt[key], next[key]), `attempt ${attempt.id} ${key} is immutable.`);
    requireInvariant(attempt.runId === null || attempt.runId === next.runId, `attempt ${attempt.id} run binding is immutable.`);
    requireInvariant(attempt.changedFiles === undefined || same(attempt.changedFiles, next.changedFiles), `attempt ${attempt.id} changed files are recorded once.`);
    const previousLive = attempt.liveDirections ?? [];
    const nextLive = next.liveDirections ?? [];
    requireInvariant(nextLive.length >= previousLive.length, `attempt ${attempt.id} live reservations cannot be removed.`);
    const current = latestAttempt.get(next.actorId) === next.id;
    for (let index = 0; index < previousLive.length; index++) {
      const previous = previousLive[index]!;
      const delivery = nextLive[index]!;
      for (const key of ["messageId", "directionVersion", "createdAt"] as const) requireInvariant(same(previous[key], delivery[key]), `attempt ${attempt.id} live reservation ${key} is immutable.`);
      if (previous.state !== "reserved") requireInvariant(same(previous, delivery), `attempt ${attempt.id} live delivery outcome is immutable.`);
      else if (delivery.state !== "reserved" && delivery.state !== "uncertain") {
        requireInvariant(
          next.generation === after.generation && ["active", "attention"].includes(after.state) && next.state === "running" && next.endedAt === null && current,
          `attempt ${attempt.id} live delivery is fenced from a noncurrent or inactive attempt.`,
        );
        const message = messages.get(delivery.messageId);
        requireInvariant(
          delivery.state === "accepted" ? message?.state === "claimed" && message.attemptId === next.id : message?.state === "pending" && message.attemptId === null,
          `attempt ${attempt.id} live delivery outcome must retain or release its exact mailbox claim.`,
        );
      }
    }
    if (nextLive.length > previousLive.length) {
      requireInvariant(
        previousLive.every((item) => item.state !== "reserved" && item.state !== "uncertain"),
        `attempt ${attempt.id} has unresolved live direction.`,
      );
      requireInvariant(nextLive.length === previousLive.length + 1, `attempt ${attempt.id} must reserve live direction one at a time.`);
      const delivery = nextLive.at(-1)!;
      const message = messages.get(delivery.messageId);
      requireInvariant(delivery.state === "reserved", `attempt ${attempt.id} live direction must be reserved before its native outcome.`);
      requireInvariant(
        attempt.state === "running" &&
          next.state === "running" &&
          next.runId !== null &&
          next.generation === after.generation &&
          ["active", "attention"].includes(after.state) &&
          next.endedAt === null &&
          current,
        `attempt ${attempt.id} live reservation requires the current active actor run.`,
      );
      requireInvariant(
        message &&
          (message.kind === "chat" ||
            after.messages.some(
              (item) =>
                item.recipientId === next.actorId &&
                (item.delivery === "immediate" || item.sendNowAt !== undefined) &&
                item.sequence >= message.sequence &&
                (item.state === "pending" || item.state === "claimed"),
            )),
        `attempt ${attempt.id} live promotion requires pending immediate intent.`,
      );
      requireInvariant(
        !after.messages.some((item) => item.recipientId === next.actorId && item.sequence < message!.sequence && item.state === "pending"),
        `attempt ${attempt.id} live reservation cannot overtake pending input.`,
      );
      requireInvariant(message?.state === "claimed" && message.attemptId === next.id, `attempt ${attempt.id} live reservation must claim its message before delivery.`);
    }
  });
  for (const attempt of after.attempts.slice(before.attempts.length)) {
    requireInvariant(attempt.generation === after.generation, `new attempt ${attempt.id} must use the current generation.`);
    requireInvariant(!attempt.liveDirections?.length, `new attempt ${attempt.id} cannot contain live reservations before its run starts.`);
  }
  before.messages.forEach((message, index) => {
    if (!changes.messages.has(message.id)) return;
    const next = after.messages[index]!;
    for (const key of ["sequence", "senderId", "recipientId", "kind", "body", "attachments", "delivery", "dedupeKey", "createdAt", "chatId", "to"] as const)
      requireInvariant(same(message[key], next[key]), `message ${message.id} ${key} is immutable.`);
    if (message.sendNowAt !== undefined) requireInvariant(next.sendNowAt === message.sendNowAt, `message ${message.id} send-now request is immutable.`);
    if (message.state === "cancelled")
      requireInvariant(next.state === "cancelled" && next.cancelledAt === message.cancelledAt, `message ${message.id} cancellation is immutable and cannot be reversed.`);
    else if (next.state === "cancelled") requireInvariant(message.state === "pending" && message.attemptId === null, `message ${message.id} must still be pending before cancellation.`);
  });
}

/** The entries an update added or changed, by kind; everything else is untouched history. */
type Changes = Record<(typeof KINDS)[number], ReadonlySet<string>>;

/** Parses the entries an update added or changed; the rest are the journal's own, already parsed entries. */
function diff<T extends { id: string }>(schema: z.ZodType<T>, known: ReadonlyMap<string, string>, after: readonly T[]) {
  const entries = new Map<string, string>();
  const changed = new Set<string>();
  const items = after.map((item) => {
    const json = JSON.stringify(item);
    if (known.get(item.id) === json) {
      entries.set(item.id, json);
      return item;
    }
    const parsed = schema.parse(item);
    const canonical = JSON.stringify(parsed);
    entries.set(item.id, canonical);
    if (known.get(item.id) !== canonical) changed.add(item.id);
    return parsed;
  });
  return { items, entries, changed };
}
const ExecutionFields = TeamExecutionRecord.omit({ actors: true, attempts: true, messages: true, claims: true });
function normalize(before: Snapshot, draft: TeamExecutionRecord): { record: TeamExecutionRecord; entries: Entries; changes: Changes } {
  const { actors, attempts, messages, claims, ...fields } = draft;
  requireInvariant(Array.isArray(actors) && Array.isArray(attempts) && Array.isArray(messages) && (claims === undefined || Array.isArray(claims)), "journal entries must be lists.");
  const parsed = {
    actors: diff(TeamActorRecord, before.entries.actors, actors),
    attempts: diff(TeamAttemptRecord, before.entries.attempts, attempts),
    messages: diff(TeamMailboxMessage, before.entries.messages, messages),
    claims: diff(TeamFileClaim, before.entries.claims, claims ?? []),
  };
  return {
    record: {
      ...ExecutionFields.parse(fields),
      actors: parsed.actors.items,
      attempts: parsed.attempts.items,
      messages: parsed.messages.items,
      ...(parsed.claims.items.length ? { claims: parsed.claims.items } : {}),
    },
    entries: { actors: parsed.actors.entries, attempts: parsed.attempts.entries, messages: parsed.messages.entries, claims: parsed.claims.entries },
    changes: { actors: parsed.actors.changed, attempts: parsed.attempts.changed, messages: parsed.messages.changed, claims: parsed.claims.changed },
  };
}

/** Inserts the new entries and rewrites the changed ones; unchanged rows are never touched. */
function sync<T extends { id: string }>(db: Db, table: Table<T>, executionId: string, known: ReadonlyMap<string, string>, after: readonly T[], changed: ReadonlySet<string>): void {
  after.forEach((item, index) => {
    if (!changed.has(item.id)) return;
    const values = table.values(item, index);
    if (!known.has(item.id)) db.stmt(`INSERT INTO ${table.name} (execution_id, ${table.columns.join(", ")}) VALUES (?, ${table.columns.map(() => "?").join(", ")})`).run(executionId, ...values);
    else
      db.stmt(
        `UPDATE ${table.name} SET ${table.columns
          .slice(1)
          .map((column) => `${column} = ?`)
          .join(", ")} WHERE execution_id = ? AND id = ?`,
      ).run(...values.slice(1), executionId, item.id);
  });
}

function write(db: Db, before: Snapshot | null, record: TeamExecutionRecord, changes: Changes): void {
  if (!before)
    db.stmt(
      "INSERT INTO team_executions (id, instance_id, thread_id, project_id, state, generation, revision, error, deadline_at, limits, admission_scope, admission_request_key, admission_payload_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      record.id,
      record.instanceId,
      record.threadId,
      record.projectId,
      record.state,
      record.generation,
      record.revision,
      record.error,
      record.deadlineAt,
      JSON.stringify(record.limits),
      record.admission?.scope ?? null,
      record.admission?.requestKey ?? null,
      record.admission?.payloadHash ?? null,
      record.createdAt,
      record.updatedAt,
    );
  else {
    const result = db
      .stmt("UPDATE team_executions SET state = ?, generation = ?, revision = ?, error = ?, updated_at = ? WHERE id = ? AND revision = ?")
      .run(record.state, record.generation, record.revision, record.error, record.updatedAt, record.id, before.record.revision);
    requireInvariant(result.changes === 1, "execution changed during the update; reload its current revision and retry.");
  }
  const none = new Map<string, string>();
  sync(db, actorTable, record.id, before?.entries.actors ?? none, record.actors, changes.actors);
  sync(db, attemptTable, record.id, before?.entries.attempts ?? none, record.attempts, changes.attempts);
  sync(db, messageTable, record.id, before?.entries.messages ?? none, record.messages, changes.messages);
  sync(db, claimTable, record.id, before?.entries.claims ?? none, record.claims ?? [], changes.claims);
}

/** Binding rows only grow. Follow-ups retain earlier task and provider Run owners. */
function retainBindings(db: Db, before: TeamExecutionRecord | null, record: TeamExecutionRecord): void {
  const knownActors = new Set(before?.actors.map((actor) => actor.id));
  for (const actor of record.actors)
    if (actor.taskId !== null && !knownActors.has(actor.id)) {
      db.stmt("INSERT OR IGNORE INTO team_assignment_bindings (task_id, execution_id, actor_id) VALUES (?, ?, ?)").run(actor.taskId, record.id, actor.id);
      const existing = assignment(db, record.id, actor.id);
      requireInvariant(existing?.taskId === actor.taskId, `task ${actor.taskId} is already bound elsewhere or its binding is missing.`);
    }
  // The binding names the process and who owns it, and the journal names the turns that ran on it. For a run that
  // served one turn the two coincide, which is every lead turn and every isolated assignment.
  const knownRuns = new Set(before?.attempts.flatMap((attempt) => (attempt.runId ? [attempt.runId] : [])));
  const owners = new Map<string, TeamAttemptRecord>();
  for (const attempt of record.attempts) if (attempt.runId !== null && !owners.has(attempt.runId)) owners.set(attempt.runId, attempt);
  for (const [runId, owner] of owners) {
    if (knownRuns.has(runId)) continue;
    db.stmt("INSERT OR IGNORE INTO team_run_bindings (run_id, execution_id, actor_id, attempt_id, generation) VALUES (?, ?, ?, ?, ?)").run(runId, record.id, owner.actorId, owner.id, owner.generation);
    const existing = binding(db, runId);
    requireInvariant(
      existing?.executionId === record.id && existing.actorId === owner.actorId && existing.attemptId === owner.id && existing.generation === owner.generation,
      `run ${runId} is already bound elsewhere or its binding is missing.`,
    );
  }
  const taskCount = db.stmt("SELECT COUNT(*) AS total FROM team_assignment_bindings WHERE execution_id = ?").get(record.id) as { total: number };
  const runCount = db.stmt("SELECT COUNT(*) AS total FROM team_run_bindings WHERE execution_id = ?").get(record.id) as { total: number };
  requireInvariant(taskCount.total === record.actors.filter((actor) => actor.taskId !== null).length && runCount.total === owners.size, "the journal omits retained task or run bindings.");
}

/** Synchronous transactions keep dispatch creation and its journal reservation atomic. */
export const teamRuntime = {
  create(db: Db, input: TeamExecutionRecord): TeamExecutionRecord {
    const record = TeamExecutionRecord.parse(input);
    requireInvariant(
      record.revision === 0 &&
        record.generation === 1 &&
        record.state === "active" &&
        record.attempts.length === 0 &&
        record.messages.length === 0 &&
        record.actors.filter((actor) => !actor.participant).length === 1 &&
        record.actors.every((actor) => actor.id === "lead" || (actor.participant && actor.state === "waiting")),
      "a new execution starts active at revision 0, generation 1, with its lead, idle participants and no attempts or messages.",
    );
    return db.transaction(() => {
      validateJournal(record);
      validateReferences(db, null, record);
      if (record.admission)
        requireInvariant(
          !teamRuntime.findAdmission(
            db,
            record.admission.scope === "project"
              ? { scope: "project", projectId: record.projectId, requestKey: record.admission.requestKey }
              : { scope: "thread", threadId: record.threadId, requestKey: record.admission.requestKey },
          ),
          "this request key already admitted a team execution.",
        );
      requireInvariant(!db.stmt("SELECT 1 FROM team_executions WHERE thread_id = ? AND state NOT IN ('completed', 'stopped')").get(record.threadId), "this thread already has an open team execution.");
      const entries = entriesOf(record);
      write(db, null, record, { actors: new Set(entries.actors.keys()), attempts: new Set(), messages: new Set(), claims: new Set(entries.claims.keys()) });
      retainBindings(db, null, record);
      remember(db, record, entries);
      return record;
    });
  },
  get(db: Db, id: string): TeamExecutionRecord | null {
    const record = current(db, id);
    return record ? structuredClone(record) : null;
  },
  findAdmission(db: Db, input: { scope: "project"; projectId: string; requestKey: string } | { scope: "thread"; threadId: string; requestKey: string }): TeamExecutionRecord | null {
    const column = input.scope === "project" ? "project_id" : "thread_id";
    const owner = input.scope === "project" ? input.projectId : input.threadId;
    const rows = db.stmt(`SELECT id FROM team_executions WHERE ${column} = ? AND admission_scope = ? AND admission_request_key = ?`).all(owner, input.scope, input.requestKey) as { id: string }[];
    requireInvariant(rows.length <= 1, "duplicate durable admission keys require recovery.");
    return rows[0] ? teamRuntime.get(db, rows[0].id) : null;
  },
  /** The user's chat request key fans out to one row per addressee; any row proves the request was admitted. */
  findUserChat(db: Db, threadId: string, requestKey: string): { executionId: string; messages: TeamMailboxMessage[] } | null {
    const prefix = `chat:user:${requestKey}:`;
    const rows = db
      .stmt("SELECT DISTINCT e.id FROM team_executions e JOIN team_messages m ON m.execution_id = e.id WHERE e.thread_id = ? AND m.dedupe_key >= ? AND m.dedupe_key < ? AND m.sender_id = 'user'")
      .all(threadId, prefix, `${prefix}\u{10FFFF}`) as { id: string }[];
    requireInvariant(rows.length <= 1, "duplicate durable user chat keys require recovery.");
    if (!rows[0]) return null;
    const record = teamRuntime.get(db, rows[0].id)!;
    return { executionId: record.id, messages: record.messages.filter((item) => item.senderId === "user" && item.dedupeKey.startsWith(prefix)) };
  },
  findUserDirection(db: Db, threadId: string, requestKey: string): { executionId: string; message: TeamMailboxMessage } | null {
    const key = `direction:user:${requestKey}`;
    const rows = db
      .stmt("SELECT DISTINCT e.id FROM team_executions e JOIN team_messages m ON m.execution_id = e.id WHERE e.thread_id = ? AND m.dedupe_key = ? AND m.sender_id = 'user'")
      .all(threadId, key) as { id: string }[];
    requireInvariant(rows.length <= 1, "duplicate durable user direction keys require recovery.");
    if (!rows[0]) return null;
    const record = teamRuntime.get(db, rows[0].id)!;
    return { executionId: record.id, message: record.messages.find((item) => item.senderId === "user" && item.dedupeKey === key)! };
  },
  activeForThread(db: Db, threadId: string): TeamExecutionRecord | null {
    const row = db.stmt("SELECT id FROM team_executions WHERE thread_id = ? AND state NOT IN ('completed', 'stopped')").get(threadId) as { id: string } | undefined;
    return row ? teamRuntime.get(db, row.id) : null;
  },
  /** Open execution ids, oldest first, without reading their journals: callers read each on its own so one bad journal stays contained. */
  openIds(db: Db): string[] {
    return (db.stmt("SELECT id FROM team_executions WHERE state NOT IN ('completed', 'stopped') ORDER BY created_at, id").all() as { id: string }[]).map((row) => row.id);
  },
  listOpen(db: Db): TeamExecutionRecord[] {
    return teamRuntime.openIds(db).map((id) => teamRuntime.get(db, id)!);
  },
  update<T>(db: Db, id: string, mutate: (record: TeamExecutionRecord) => T): { record: TeamExecutionRecord; value: T } {
    return db.transaction(() => {
      const before = snapshot(db, id);
      if (!before) throw new Error(`Team execution ${id} was not found.`);
      const draft = structuredClone(before.record);
      const value = mutate(draft);
      requireInvariant(!(value && typeof (value as { then?: unknown }).then === "function"), "update callbacks must be synchronous.");
      const { record, entries, changes } = normalize(before, draft);
      immutableHistory(before.record, record, changes);
      record.revision = before.record.revision + 1;
      record.updatedAt = Math.max(Date.now(), before.record.updatedAt);
      validateJournal(record);
      validateReferences(db, before.record, record);
      write(db, before, record, changes);
      retainBindings(db, before.record, record);
      remember(db, record, entries);
      return { record, value };
    });
  },
  /** Whether the lead took a turn in any later execution of the same team conversation, in history order. */
  leadRanAfter(db: Db, executionId: string): boolean {
    return Boolean(
      db
        .stmt(
          `SELECT 1 FROM team_executions this JOIN team_executions later ON later.instance_id = this.instance_id
          AND (later.created_at > this.created_at OR (later.created_at = this.created_at AND later.rowid > this.rowid))
          JOIN team_attempts attempt ON attempt.execution_id = later.id AND attempt.actor_id = 'lead'
          WHERE this.id = ? LIMIT 1`,
        )
        .get(executionId),
    );
  },
  /** The exact input a reserved turn hands its provider, written once with the reservation and read when it starts. */
  recordPrompt(db: Db, executionId: string, attemptId: string, prompt: string): void {
    db.stmt("INSERT INTO team_attempt_prompts (execution_id, attempt_id, prompt) VALUES (?, ?, ?)").run(executionId, attemptId, prompt);
  },
  prompt(db: Db, executionId: string, attemptId: string): string | null {
    const row = db.stmt("SELECT prompt FROM team_attempt_prompts WHERE execution_id = ? AND attempt_id = ?").get(executionId, attemptId) as { prompt: string } | undefined;
    return row?.prompt ?? null;
  },
  binding,
  assignment,
  assignmentsForTask,
  assignmentForTask,
};
