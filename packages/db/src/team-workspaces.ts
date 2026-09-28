import { TeamPublicationRecord, TeamWorkspaceRecord } from "@openorc/protocol";
import type { Db } from "./database.js";
import { teamRuntime } from "./team-runtime.js";

interface WorkspaceRow {
  id: string;
  execution_id: string;
  actor_id: string;
  created_at: number;
  payload: string;
}
interface PublicationRow {
  id: string;
  execution_id: string;
  source_actor_id: string;
  target_actor_id: string;
  output_tree: string;
  created_at: number;
  payload: string;
}
function decodeWorkspace(row: WorkspaceRow): TeamWorkspaceRecord {
  const record = TeamWorkspaceRecord.parse(JSON.parse(row.payload));
  if (record.id !== row.id || record.executionId !== row.execution_id || record.actorId !== row.actor_id || record.createdAt !== row.created_at)
    throw new Error("Workspace journal ownership differs from its indexed identity. Preserve the database for recovery.");
  return record;
}
function decodePublication(row: PublicationRow): TeamPublicationRecord {
  const record = TeamPublicationRecord.parse(JSON.parse(row.payload));
  if (
    record.id !== row.id ||
    record.executionId !== row.execution_id ||
    record.sourceActorId !== row.source_actor_id ||
    record.targetActorId !== row.target_actor_id ||
    record.outputTree !== row.output_tree ||
    record.createdAt !== row.created_at
  )
    throw new Error("Publication journal ownership differs from its indexed identity. Preserve the database for recovery.");
  return record;
}

/** Durable filesystem intents are separate from the provider/coordination journal. */
export const teamWorkspaces = {
  get(db: Db, executionId: string, actorId: string): TeamWorkspaceRecord | null {
    const row = db.stmt("SELECT * FROM team_workspaces WHERE execution_id = ? AND actor_id = ?").get(executionId, actorId) as unknown as WorkspaceRow | undefined;
    return row ? decodeWorkspace(row) : null;
  },
  list(db: Db): TeamWorkspaceRecord[] {
    return (db.stmt("SELECT * FROM team_workspaces ORDER BY created_at, id").all() as unknown as WorkspaceRow[]).map(decodeWorkspace);
  },
  save(db: Db, input: TeamWorkspaceRecord): TeamWorkspaceRecord {
    const record = TeamWorkspaceRecord.parse(input);
    const execution = teamRuntime.get(db, record.executionId);
    const actor = execution?.actors.find((item) => item.id === record.actorId);
    if (!actor || actor.taskId !== record.taskId || actor.parentId !== record.parentActorId) throw new Error("Workspace actor, task and parent must belong to the recorded execution.");
    const old = teamWorkspaces.get(db, record.executionId, record.actorId);
    if (
      old &&
      ["id", "executionId", "actorId", "taskId", "parentActorId", "source", "createdAt"].some(
        (key) => JSON.stringify(old[key as keyof TeamWorkspaceRecord]) !== JSON.stringify(record[key as keyof TeamWorkspaceRecord]),
      )
    )
      throw new Error("A prepared workspace's source and identity cannot be replaced.");
    // Only an explicitly retried blocked setup may move to a new directory, and only by retiring the old one untouched.
    const retiring = Boolean(old && old.path !== record.path);
    const retired = record.retired ?? [],
      previous = old?.retired ?? [];
    if (retiring) {
      if (old!.state !== "attention" || old!.setupState !== "blocked" || old!.outputTree !== null) throw new Error("Only a blocked setup without captured output can retire its directory.");
      if (
        retired.length !== previous.length + 1 ||
        JSON.stringify(retired.slice(0, -1)) !== JSON.stringify(previous) ||
        retired.at(-1)!.path !== old!.path ||
        retired.at(-1)!.preparedTree !== old!.preparedTree ||
        retired.at(-1)!.error !== old!.error ||
        record.preparedTree !== null ||
        record.outputTree !== null ||
        retired.some((item) => item.path === record.path)
      )
        throw new Error("Retiring a blocked setup must record its exact directory and start the new one unprepared.");
    } else if (JSON.stringify(retired) !== JSON.stringify(previous)) throw new Error("Retired setup directories are append-only history.");
    if (old?.preparedTree && !retiring && old.preparedTree !== record.preparedTree) throw new Error("A workspace's verified input tree is immutable.");
    if (old?.outputTree && actor.state === "completed" && old.outputTree !== record.outputTree) throw new Error("Completed assignment output is immutable.");
    if (old?.setupAccepted && JSON.stringify(old.setupAccepted) !== JSON.stringify(record.setupAccepted)) throw new Error("An accepted setup delta is immutable.");
    if (record.setupAccepted && (record.setupAccepted.sourceTree !== record.source.treeSha || record.setupAccepted.preparedTree !== record.preparedTree))
      throw new Error("An accepted setup delta must name this workspace's captured input and prepared tree.");
    const recovery = record.recovery ?? [],
      previousRecovery = old?.recovery ?? [];
    if (JSON.stringify(recovery.slice(0, previousRecovery.length)) !== JSON.stringify(previousRecovery) || new Set(recovery.map((item) => item.requestKey)).size !== recovery.length)
      throw new Error("Recovery requests are append-only and distinct.");
    db.stmt("INSERT INTO team_workspaces (id, execution_id, actor_id, payload, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(execution_id, actor_id) DO UPDATE SET payload = excluded.payload").run(
      record.id,
      record.executionId,
      record.actorId,
      JSON.stringify(record),
      record.createdAt,
    );
    return record;
  },
  publications(db: Db, executionId?: string): TeamPublicationRecord[] {
    const rows = executionId
      ? db.stmt("SELECT * FROM team_publications WHERE execution_id = ? ORDER BY created_at, id").all(executionId)
      : db.stmt("SELECT * FROM team_publications ORDER BY created_at, id").all();
    return (rows as unknown as PublicationRow[]).map(decodePublication);
  },
  publication(db: Db, id: string): TeamPublicationRecord | null {
    const row = db.stmt("SELECT * FROM team_publications WHERE id = ?").get(id) as unknown as PublicationRow | undefined;
    return row ? decodePublication(row) : null;
  },
  savePublication(db: Db, input: TeamPublicationRecord): TeamPublicationRecord {
    const record = TeamPublicationRecord.parse(input);
    const execution = teamRuntime.get(db, record.executionId);
    const source = execution?.actors.find((item) => item.id === record.sourceActorId);
    const target = execution?.actors.find((item) => item.id === record.targetActorId);
    const sourceWorkspace = teamWorkspaces.get(db, record.executionId, record.sourceActorId);
    const targetWorkspace = teamWorkspaces.get(db, record.executionId, record.targetActorId);
    if (!source || source.state !== "completed" || !target || source.parentId !== target.id || sourceWorkspace?.outputTree !== record.outputTree || targetWorkspace?.path !== record.destinationPath)
      throw new Error("Publication must connect a completed child's retained output to its own manager workspace.");
    if (
      record.entries.some((entry) => (!entry.before && !entry.after) || (entry.before && entry.before.path !== entry.path) || (entry.after && entry.after.path !== entry.path)) ||
      new Set(record.entries.map((entry) => entry.path)).size !== record.entries.length
    )
      throw new Error("Publication entries must retain unique recorded paths and before/after content.");
    if (new Set(record.includedActorIds).size !== record.includedActorIds.length || !record.includedActorIds.includes(source.id))
      throw new Error("Publication provenance must include its source exactly once.");
    for (const id of record.includedActorIds) {
      let actor = execution!.actors.find((item) => item.id === id);
      while (actor && actor.id !== source.id) actor = execution!.actors.find((item) => item.id === actor!.parentId);
      if (!actor) throw new Error("Publication provenance must belong to the source assignment's subtree.");
    }
    const old = teamWorkspaces.publication(db, record.id);
    if (old) {
      const immutable: (keyof TeamPublicationRecord)[] = ["id", "executionId", "sourceActorId", "targetActorId", "outputTree", "destinationPath", "includedActorIds", "createdAt"];
      if (immutable.some((key) => JSON.stringify(old[key]) !== JSON.stringify(record[key]))) throw new Error("Publication identity and input cannot change.");
      if (old.state === "applied" && JSON.stringify({ ...old, recovery: undefined, updatedAt: 0 }) !== JSON.stringify({ ...record, recovery: undefined, updatedAt: 0 }))
        throw new Error("An applied integration receipt is immutable.");
      if (old.afterTree && (old.afterTree !== record.afterTree || JSON.stringify(old.entries) !== JSON.stringify(record.entries))) throw new Error("A publication's verified delta cannot change.");
      // Scratch storage and the destination capture change only through an explicit retry before any merge result exists.
      const retired = record.retiredScratchPaths ?? [],
        previous = old.retiredScratchPaths ?? [];
      const retrying = old.scratchPath !== record.scratchPath || JSON.stringify(old.before) !== JSON.stringify(record.before);
      if (retrying) {
        if (!["conflict", "attention", "planned"].includes(old.state) || old.afterTree !== null || record.afterTree !== null)
          throw new Error("Only an unpublished conflicting or interrupted integration can retire its scratch workspace.");
        if (
          old.scratchPath === record.scratchPath ||
          retired.length !== previous.length + 1 ||
          JSON.stringify(retired.slice(0, -1)) !== JSON.stringify(previous) ||
          retired.at(-1) !== old.scratchPath ||
          retired.includes(record.scratchPath)
        )
          throw new Error("Retiring scratch storage must record the exact previous path.");
      } else if (JSON.stringify(retired) !== JSON.stringify(previous)) throw new Error("Retired scratch paths are append-only history.");
      const recovery = record.recovery ?? [],
        previousRecovery = old.recovery ?? [];
      if (JSON.stringify(recovery.slice(0, previousRecovery.length)) !== JSON.stringify(previousRecovery) || new Set(recovery.map((item) => item.requestKey)).size !== recovery.length)
        throw new Error("Recovery requests are append-only and distinct.");
    }
    db.stmt(
      "INSERT INTO team_publications (id, execution_id, source_actor_id, target_actor_id, output_tree, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
    ).run(record.id, record.executionId, record.sourceActorId, record.targetActorId, record.outputTree, JSON.stringify(record), record.createdAt);
    return record;
  },
};
