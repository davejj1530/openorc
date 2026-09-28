import {
  orchestration,
  runs,
  tasks,
  teamContextParts,
  teamContexts,
  teamDeletedThreads,
  teamMoves,
  teamOrigins,
  teamRestores,
  teamRuntime,
  teamTaskCompletions,
  teamTasks,
  teamWorkspaces,
  type Db,
  type TeamContextReference,
  type TeamRestoreRecord,
} from "@openorc/db";
import { MAX_TEAM_CONTEXT_BYTES, teamAttemptMessageIds, type TeamActorRecord, type TeamExecutionRecord } from "@openorc/protocol";

export interface TeamContextScope {
  instanceId: string;
  executionId: string | null;
  actorId: string;
}

/** Stable journal order also disambiguates executions created in the same millisecond. */
export function teamContextExecutions(db: Db, instanceId: string): TeamExecutionRecord[] {
  const rows = db.stmt("SELECT id FROM team_executions WHERE instance_id = ? ORDER BY created_at, rowid").all(instanceId) as { id: string }[];
  return rows.map((row) => teamRuntime.get(db, row.id)!);
}

function clip(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  let result = "";
  let used = 0;
  for (const character of text) {
    const length = Buffer.byteLength(character);
    if (used + length > bytes - 3) break;
    result += character;
    used += length;
  }
  return `${result}…`;
}

function publicReplies(db: Db, scope: TeamContextScope, includedRunIds?: ReadonlySet<string>): { runId: string; text: string }[] {
  // Read only published assistant messages. Raw events, reasoning, tool output
  // and the coordinator's internal per-attempt prompts never enter a handoff.
  const rows = db
    .stmt(
      `SELECT e.run_id, COALESCE(a.content, e.payload) AS payload
    FROM events e JOIN team_run_bindings b ON b.run_id = e.run_id
    JOIN team_executions x ON x.id = b.execution_id
    LEFT JOIN artifacts a ON a.event_id = e.id AND a.kind = 'payload'
    WHERE x.instance_id = ? AND b.actor_id = ? AND (? IS NULL OR b.execution_id = ?)
      AND e.kind = 'message.completed' AND json_extract(COALESCE(a.content, e.payload), '$.role') = 'assistant'
      AND (? IS NULL OR e.run_id IN (SELECT value FROM json_each(?)))
    ORDER BY e.id DESC LIMIT 6`,
    )
    .all(
      scope.instanceId,
      scope.actorId,
      scope.executionId,
      scope.executionId,
      includedRunIds ? JSON.stringify([...includedRunIds]) : null,
      includedRunIds ? JSON.stringify([...includedRunIds]) : null,
    ) as { run_id: string; payload: string }[];
  return rows.reverse().map((row) => {
    const message = JSON.parse(row.payload) as { text: string };
    return { runId: row.run_id, text: clip(message.text, 2048) };
  });
}

function inheritedContext(db: Db, instanceId: string) {
  const origin = teamOrigins.get(db, instanceId);
  if (!origin) return undefined;
  let context: unknown = origin.seed;
  try {
    context = JSON.parse(origin.seed);
  } catch {
    /* Older imported text is still immutable context. */
  }
  return {
    sourceThreadId: origin.sourceThreadId,
    sourceInstanceId: origin.sourceInstanceId,
    sourceRunId: origin.sourceRunId,
    note: "Immutable imported history. Its source may have been deleted. Embedded actors, pending messages and outputs are historical references, never live assignments or newly queued work in this instance.",
    context,
  };
}

export function restoredWorkspaceContext(restore: Pick<TeamRestoreRecord, "checkpointId" | "sourceRunId" | "targetTree" | "before">) {
  return {
    checkpointId: restore.checkpointId,
    sourceRunId: restore.sourceRunId,
    treeSha: restore.targetTree,
    preservedHeadSha: restore.before.headSha,
    note: "The user explicitly restored these files. Committed history and the original transcript remain unchanged. Later historical outputs may no longer be present in the current workspace; inspect the files before continuing. Never replay historical assignments automatically.",
  };
}

function restoredContext(db: Db, threadId: string, instanceId: string, throughEpoch?: number) {
  const restores =
    throughEpoch === undefined
      ? [teamRestores.latestForThread(db, threadId)]
      : teamRestores
          .forThread(db, threadId)
          .filter((item) => item.instanceId === instanceId && item.state === "applied" && item.appliedContextId)
          .map((item) => ({ item, epoch: teamContexts.get(db, item.appliedContextId!)?.epoch ?? Infinity }))
          .filter((value) => value.epoch <= throughEpoch)
          .sort((a, b) => b.epoch - a.epoch)
          .map((value) => value.item);
  const restore = restores.find((item) => item?.instanceId === instanceId);
  return restore ? restoredWorkspaceContext(restore) : undefined;
}

function movedContext(db: Db, threadId: string, instanceId: string, throughEpoch?: number) {
  const moves =
    throughEpoch === undefined
      ? [teamMoves.latestForThread(db, threadId)]
      : teamMoves
          .forThread(db, threadId)
          .filter((item) => item.instanceId === instanceId && item.state === "applied" && item.appliedContextId)
          .map((item) => ({ item, epoch: teamContexts.get(db, item.appliedContextId!)?.epoch ?? Infinity }))
          .filter((value) => value.epoch <= throughEpoch)
          .sort((a, b) => b.epoch - a.epoch)
          .map((value) => value.item);
  const move = moves.find((item) => item?.instanceId === instanceId);
  return move
    ? {
        to: move.to,
        createdAt: move.updatedAt,
        note: "Historical workspace move requested by the user. Current runtime workspace instructions take precedence over historical paths and location. Other local files and staging were preserved. Do not replay old assignments.",
      }
    : undefined;
}

/**
 * A deleted conversation leaves its saved tasks a bounded, task-only handoff:
 * accepted requests, their outcomes and provenance. The original freeform
 * instructions and directions stay in history and are not carried forward.
 */
export function retainedTaskContext(db: Db, instanceId: string, taskIds: readonly string[]) {
  return {
    note: "The user deleted this team conversation. Only its saved tasks remain. Work only on accepted task requests; never revive the deleted conversation's earlier freeform instructions or replay historical assignments.",
    tasks: [...taskIds].sort().map((taskId) => {
      const task = tasks.get(db, taskId);
      const intent = teamTasks.intent(db, taskId);
      const admissions = teamTasks.admissions(db, taskId).filter((item) => item.instanceId === instanceId);
      return {
        taskId,
        title: task?.title ?? "",
        status: task?.status ?? "unknown",
        ...(intent ? { managerKey: intent.managerKey, memberKey: intent.memberKey, dependencyTaskIds: intent.dependencyTaskIds } : {}),
        acceptedRequests: admissions.map((item) => {
          const completion = teamTaskCompletions.get(db, item.id);
          return {
            admissionId: item.id,
            kind: item.kind,
            createdAt: item.createdAt,
            reviewBatchId: item.reviewBatchId,
            ...(item.kind === "review" && item.reviewBatchId ? { feedback: clip(teamTasks.batch(db, item.reviewBatchId)?.prompt ?? "", 2048) } : {}),
            result: clip(completion?.result ?? "", 1024),
          };
        }),
      };
    }),
  };
}

export function buildTeamRetainedSeed(db: Db, scope: TeamContextScope, taskIds: readonly string[]): string {
  return boundedSeed(db, scope.instanceId, {
    format: "openorc-team-retained-tasks-v1",
    scope,
    deletedConversation: retainedTaskContext(db, scope.instanceId, taskIds),
    canonical: [],
    outcomes: [],
    publicReplies: [],
  });
}

/** Later notes (moves, restores) are appended to a stored seed; leave them room. */
const SEED_TARGET_BYTES = MAX_TEAM_CONTEXT_BYTES - 2048;
const STORED_NOTE =
  "Some verbatim history exceeded this seed's size and is stored unchanged outside it. Wherever an entry has a stored id, read that exact text with the team_context tool before acting on it. Stored text is the original message or a JSON array of the original entries; nothing was summarized or discarded.";
interface CanonicalEntry {
  originalInstruction?: string | TeamContextReference;
  directions?: unknown[] | (TeamContextReference & { count: number });
  [key: string]: unknown;
}
interface SeedContext {
  publicReplies: unknown[];
  outcomes: { result: string }[];
  canonical: CanonicalEntry[];
  origin?: { context: unknown };
  deletedConversation?: { tasks: Record<string, unknown>[] };
  storedText?: string;
  [key: string]: unknown;
}
type Spill = (store: (text: string) => TeamContextReference) => void;

/**
 * Overflow moves into stored parts oldest first: inherited history, deleted
 * conversation tasks, then each execution's instruction and direction. The
 * newest requirements stay inline longest; whole arrays go last.
 */
function spills(context: SeedContext): Spill[] {
  const large = (text: string) => Buffer.byteLength(text) > 256;
  const result: Spill[] = [];
  const origin = context.origin;
  if (origin)
    result.push((store) => {
      const text = JSON.stringify(origin.context);
      if (large(text)) origin.context = store(text);
    });
  for (const task of context.deletedConversation?.tasks ?? [])
    result.push((store) => {
      const text = JSON.stringify(task);
      if (!large(text)) return;
      const { taskId, title, status } = task;
      for (const key of Object.keys(task)) delete task[key];
      Object.assign(task, { taskId, title, status, ...store(text) });
    });
  for (const entry of context.canonical) {
    result.push((store) => {
      if (typeof entry.originalInstruction === "string" && large(entry.originalInstruction)) entry.originalInstruction = store(entry.originalInstruction);
    });
    result.push((store) => {
      if (Array.isArray(entry.directions) && entry.directions.length) {
        const text = JSON.stringify(entry.directions);
        if (large(text)) entry.directions = { count: entry.directions.length, ...store(text) };
      }
    });
  }
  result.push((store) => {
    const text = JSON.stringify(context.canonical);
    if (large(text)) context.canonical = { count: context.canonical.length, ...store(text) } as unknown as CanonicalEntry[];
  });
  result.push((store) => {
    const text = JSON.stringify(context.outcomes);
    if (large(text)) context.outcomes = { count: context.outcomes.length, ...store(text) } as unknown as { result: string }[];
  });
  return result;
}

function boundedSeed(db: Db, instanceId: string, context: SeedContext): string {
  const size = () => Buffer.byteLength(JSON.stringify(context));
  // Prefer requirements and durable output references over optional prose.
  while (size() > SEED_TARGET_BYTES && context.publicReplies.length) context.publicReplies.shift();
  if (size() > SEED_TARGET_BYTES) for (const outcome of context.outcomes) outcome.result = "";
  const store = (text: string): TeamContextReference => {
    const part = teamContextParts.put(db, instanceId, text);
    return { stored: part.id, bytes: part.bytes, preview: clip(text, 160) };
  };
  for (const spill of spills(context)) {
    if (size() <= SEED_TARGET_BYTES) break;
    spill(store);
    context.storedText = STORED_NOTE;
  }
  const seed = JSON.stringify(context);
  const bytes = Buffer.byteLength(seed);
  if (bytes > MAX_TEAM_CONTEXT_BYTES)
    throw new Error(
      `Context needs ${bytes.toLocaleString("en-US")} bytes; the limit is ${MAX_TEAM_CONTEXT_BYTES.toLocaleString("en-US")} bytes. Original instructions were preserved. No context reset was saved.`,
    );
  return seed;
}

function receipts(db: Db, executionId: string, actorId: string) {
  return teamWorkspaces
    .publications(db, executionId)
    .filter((item) => item.targetActorId === actorId && item.state === "applied")
    .map((item) => ({
      id: item.id,
      sourceActorId: item.sourceActorId,
      outputTree: item.outputTree,
      afterTree: item.afterTree,
      includedActorIds: item.includedActorIds,
    }));
}

/**
 * Rebuild from canonical history on every reset; never recursively clip an
 * earlier seed and gradually lose the user's original requirements. Instructions
 * remain verbatim. Only public-result excerpts may be clipped or omitted.
 */
export function buildTeamContextSeed(db: Db, scope: TeamContextScope, currentExecutionId?: string): string {
  const history = teamContextExecutions(db, scope.instanceId);
  const records = scope.executionId ? history.filter((record) => record.id === scope.executionId) : history;
  const origin = scope.actorId === "lead" ? inheritedContext(db, scope.instanceId) : undefined;
  if ((scope.executionId === null) !== (scope.actorId === "lead") || (records.length === 0 && !origin)) throw new Error("Context requires an existing lead or assignment scope.");
  const owner = db.stmt("SELECT thread_id FROM orchestration_team_instances WHERE id=?").get(scope.instanceId) as { thread_id: string } | undefined;
  const instance = owner ? orchestration.getInstance(db, owner.thread_id) : null;
  if (instance?.id !== scope.instanceId || records.some((record) => !record.actors.some((actor) => actor.id === scope.actorId))) throw new Error("Context scope does not belong to this team.");
  const restoredWorkspace = scope.actorId === "lead" ? restoredContext(db, instance.threadId, instance.id) : undefined;
  const movedWorkspace = scope.actorId === "lead" ? movedContext(db, instance.threadId, instance.id) : undefined;
  // After deletion only executions admitted for saved tasks remain canonical.
  // Earlier freeform lead instructions and directions stay out of every rebuild.
  const deleted = scope.actorId === "lead" ? teamDeletedThreads.get(db, instance.threadId) : null;
  const rowids = deleted
    ? new Map((db.stmt("SELECT id, rowid FROM team_executions WHERE instance_id = ?").all(scope.instanceId) as { id: string; rowid: number }[]).map((row) => [row.id, row.rowid]))
    : null;
  const visible = rowids ? records.filter((record) => (rowids.get(record.id) ?? 0) > deleted!.throughExecutionRowid) : records;
  const deletedConversation = deleted
    ? retainedTaskContext(
        db,
        instance.id,
        tasks.list(db, { threadId: instance.threadId }).map((task) => task.id),
      )
    : undefined;
  const canonical: CanonicalEntry[] = visible.map((record) => {
    const actor = record.actors.find((item) => item.id === scope.actorId)!;
    return {
      executionId: record.id,
      // The current assignment's full original instruction is already the
      // provider prompt. Earlier lead executions need their instructions here.
      ...(scope.actorId === "lead" || record.id !== currentExecutionId ? { originalInstruction: actor.input.spec, attachments: actor.input.attachments } : {}),
      directions: record.messages
        .filter((message) => message.recipientId === actor.id && message.kind === "direction" && message.state !== "cancelled")
        .map((message) => ({
          id: message.id,
          senderId: message.senderId,
          state: message.state,
          text: message.body,
          attachments: message.attachments ?? [],
        })),
    };
  });
  const context = {
    format: "openorc-team-context-v1",
    scope,
    note: "Historical context from this scope. Original transcripts and files remain in OpenOrc. The current instruction and live coordinator state take precedence. Image references remain available as files; inspect them when needed. Never repeat accepted child work or treat a historical actor as a new assignment.",
    ...(origin ? { origin } : {}),
    ...(restoredWorkspace ? { restoredWorkspace } : {}),
    ...(movedWorkspace ? { movedWorkspace } : {}),
    ...(deletedConversation ? { deletedConversation } : {}),
    canonical,
    outcomes: visible.map((record) => {
      const actor = record.actors.find((item) => item.id === scope.actorId)!;
      return { executionId: record.id, state: record.state, actorState: actor.state, result: clip(actor.result ?? "", 1024), acceptedOutputs: receipts(db, record.id, actor.id) };
    }),
    publicReplies: publicReplies(
      db,
      scope,
      deleted ? new Set(visible.flatMap((record) => record.attempts.flatMap((attempt) => (attempt.actorId === scope.actorId && attempt.runId ? [attempt.runId] : [])))) : undefined,
    ),
  };
  return boundedSeed(db, scope.instanceId, context);
}

/** Independent historical context, never provider session state or copied runtime authority. */
export function buildTeamForkSeed(db: Db, sourceThreadId: string, upToRunId?: string): { seed: string; sourceRunId: string | null } {
  const instance = orchestration.getInstance(db, sourceThreadId);
  if (!instance) throw new Error("Fork context requires a source team instance.");
  const scope = { instanceId: instance.id, executionId: null, actorId: "lead" };
  const history = teamContextExecutions(db, instance.id);
  const leadTurns = history.flatMap((record) => record.attempts.filter((attempt) => attempt.actorId === "lead" && attempt.runId).map((attempt) => ({ record, attempt })));
  if (upToRunId === undefined) return { seed: buildTeamContextSeed(db, scope), sourceRunId: leadTurns.at(-1)?.attempt.runId ?? null };
  const cut = leadTurns.findIndex(({ attempt }) => attempt.runId === upToRunId);
  if (cut < 0) throw new Error("The fork cutoff must be a lead run belonging to this source team.");
  const included = leadTurns.slice(0, cut + 1);
  const includedRunIds = new Set(included.map(({ attempt }) => attempt.runId!));
  const records = history.filter((record) => included.some((turn) => turn.record.id === record.id));
  const origin = inheritedContext(db, instance.id);
  // Context epochs, rather than wall-clock timestamps, identify what the selected
  // turn actually observed even when a restore and a turn share a millisecond.
  const checkpointId = included.at(-1)!.attempt.contextCheckpointId;
  const restoredWorkspace = restoredContext(db, sourceThreadId, instance.id, checkpointId ? (teamContexts.get(db, checkpointId)?.epoch ?? 0) : 0);
  const movedWorkspace = movedContext(db, sourceThreadId, instance.id, checkpointId ? (teamContexts.get(db, checkpointId)?.epoch ?? 0) : 0);
  const context = {
    format: "openorc-team-fork-v1",
    scope,
    sourceRunId: upToRunId,
    note: "Historical source context through the selected lead turn. Only direction reserved for or accepted by those turns is included. These source actors, messages and outputs are history, not live assignments or queued direction in the fork. Provider sessions are independent.",
    ...(origin ? { origin } : {}),
    ...(restoredWorkspace ? { restoredWorkspace } : {}),
    ...(movedWorkspace ? { movedWorkspace } : {}),
    canonical: records.map((record): CanonicalEntry => {
      const actor = record.actors.find((item) => item.id === "lead")!;
      const messageIds = new Set(included.filter((turn) => turn.record.id === record.id).flatMap(({ attempt }) => teamAttemptMessageIds(attempt)));
      return {
        executionId: record.id,
        originalInstruction: actor.input.spec,
        attachments: actor.input.attachments,
        directions: record.messages
          .filter((message) => message.recipientId === "lead" && message.kind === "direction" && messageIds.has(message.id))
          .map((message) => ({ id: message.id, senderId: message.senderId, text: message.body, attachments: message.attachments ?? [] })),
      };
    }),
    // Actor.result, current mailbox delivery state and publication sets may have
    // advanced after the cutoff. Read only public results from included runs.
    outcomes: included.map(({ record, attempt }) => ({ executionId: record.id, runId: attempt.runId, result: clip(runs.get(db, attempt.runId!)?.resultText ?? "", 1024) })),
    publicReplies: publicReplies(db, scope, includedRunIds),
  };
  return { seed: boundedSeed(db, instance.id, context), sourceRunId: upToRunId };
}

/** Rebuilt after workspace preparation/integration, never copied from a stale checkpoint. */
export function buildTeamCoordinationContext(db: Db, record: TeamExecutionRecord, actor: TeamActorRecord): string {
  return JSON.stringify({
    executionId: record.id,
    generation: record.generation,
    actorId: actor.id,
    parentId: actor.parentId,
    state: actor.state,
    directionVersion: actor.directionVersion,
    children: record.actors
      .filter((child) => child.parentId === actor.id)
      .map((child) => ({
        id: child.id,
        memberKey: child.memberKey,
        taskId: child.taskId,
        requestKey: child.requestKey,
        state: child.state,
        dependencies: child.dependencies,
        result: clip(child.result ?? "", 512),
        error: clip(child.error ?? "", 512),
      })),
    acceptedOutputs: receipts(db, record.id, actor.id),
  });
}
