import path from "node:path";
import { z } from "zod";
import { TeamContextSeed } from "@openorc/protocol";
import type { Db } from "./database.js";

const id = z
  .string()
  .min(1)
  .refine((value) => Boolean(value.trim()) && !value.includes("\0"), "An identity must not be blank or contain NUL.");
const absolute = id.refine((value) => path.isAbsolute(value) && path.normalize(value) === value, "A cleanup path must be normalized and absolute.");
const timestamp = z.number().int().nonnegative();
const FileIdentity = z.object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/), birthtimeNs: z.string().regex(/^\d+$/) }).strict();
const CleanupEntry = z
  .object({
    path: absolute,
    canonicalPath: absolute,
    repositoryRoot: absolute,
    commonDir: absolute,
    quarantinePath: absolute,
    identity: FileIdentity.nullable(),
    registration: z
      .object({ gitDir: absolute, gitDirIdentity: FileIdentity, marker: id.max(16_384), head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), branch: id.nullable() })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.quarantinePath === entry.path || entry.quarantinePath === entry.canonicalPath || (entry.registration && !entry.identity)) {
      context.addIssue({ code: "custom", message: "Cleanup needs a distinct quarantine path and a present directory for Git registration." });
    }
  });
export type TeamCleanupEntry = z.infer<typeof CleanupEntry>;
export type TeamCleanupPhase = "pending" | "quarantined" | "removed";
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
/** Git objects this owner provably created: branches by captured tip, retention refs by owned prefix. */
const GitInventory = z.object({ branches: z.array(z.object({ name: id.max(4096), tip: sha }).strict()).max(10_000), refPrefixes: z.array(id.max(4096)).max(100_000) }).strict();
const Captured = z
  .object({
    projectRoot: absolute,
    retainedTaskIds: z.array(id).max(10_000),
    deletedTaskIds: z.array(id).max(10_000).default([]),
    entries: z.array(CleanupEntry).max(10_000),
    retainedPaths: z.array(z.object({ path: absolute, reason: id }).strict()).max(100_000),
    seed: TeamContextSeed.nullable(),
    throughExecutionRowid: timestamp,
    git: GitInventory.default({ branches: [], refPrefixes: [] }),
    exports: z.array(absolute).max(100_000).default([]),
  })
  .strict()
  .superRefine((input, context) => {
    const retained = input.retainedTaskIds.length > 0;
    if (
      new Set(input.retainedTaskIds).size !== input.retainedTaskIds.length ||
      (retained && (input.entries.length !== 0 || input.seed === null)) ||
      (!retained && input.seed !== null) ||
      (input.seed !== null && !input.seed.trim())
    ) {
      context.addIssue({ code: "custom", message: "Retained tasks need a fresh context and no cleanup entries; taskless deletion needs no context." });
    }
    if (
      new Set(input.deletedTaskIds).size !== input.deletedTaskIds.length ||
      (retained && input.deletedTaskIds.length > 0) ||
      new Set(input.git.branches.map((branch) => branch.name)).size !== input.git.branches.length ||
      input.git.branches.some((branch) => !branch.name.startsWith("openorc/team-")) ||
      input.git.refPrefixes.some((prefix) => !prefix.startsWith("refs/openorc/") || !prefix.endsWith("/"))
    ) {
      context.addIssue({ code: "custom", message: "Deleted tasks belong only to a final deletion, and Git cleanup names only owned team branches and retention prefixes." });
    }
    const paths = input.entries.flatMap((entry) => [entry.canonicalPath, entry.quarantinePath]);
    if (
      new Set(paths).size !== paths.length ||
      new Set(input.entries.map((entry) => entry.path)).size !== input.entries.length ||
      input.entries.some((entry) => entry.path === input.projectRoot || entry.canonicalPath === input.projectRoot || entry.quarantinePath === input.projectRoot)
    ) {
      context.addIssue({ code: "custom", message: "Cleanup inventory must have unique destinations and must preserve the project checkout." });
    }
  });
const Identity = z.object({ id, threadId: id, instanceId: id, projectId: id, requestKey: id.max(200), requestHash: z.string().regex(/^[a-f0-9]{64}$/) });
export type CreateTeamDeletionInput = z.input<typeof Captured> & z.infer<typeof Identity>;
export type TeamDeletionGitInventory = z.infer<typeof GitInventory>;
export interface TeamDeletionRecord extends z.infer<typeof Captured>, z.infer<typeof Identity> {
  state: "pending" | "attention" | "applied" | "cancelled";
  items: { index: number; state: TeamCleanupPhase; updatedAt: number }[];
  appliedContextId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface TeamDeletedThread {
  threadId: string;
  instanceId: string;
  deletedAt: number;
  contextCheckpointId: string;
  throughExecutionRowid: number;
}
export interface TeamDeletionRejection {
  threadId: string;
  requestKey: string;
  requestHash: string;
  error: string;
  createdAt: number;
}
interface DeletionRow {
  cancelled_at: number | null;
  id: string;
  thread_id: string;
  instance_id: string;
  project_id: string;
  request_key: string;
  request_hash: string;
  captured_input: string;
  state: TeamDeletionRecord["state"];
  applied_context_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}
interface ItemRow {
  item_index: number;
  state: TeamCleanupPhase;
  updated_at: number;
}
interface DeletedRow {
  thread_id: string;
  instance_id: string;
  deleted_at: number;
  context_checkpoint_id: string;
  through_execution_rowid: number;
}
interface RejectionRow {
  thread_id: string;
  request_key: string;
  request_hash: string;
  error: string;
  created_at: number;
}
const capture = (input: CreateTeamDeletionInput) =>
  Captured.parse({
    projectRoot: input.projectRoot,
    retainedTaskIds: input.retainedTaskIds,
    deletedTaskIds: input.deletedTaskIds,
    entries: input.entries,
    retainedPaths: input.retainedPaths,
    seed: input.seed,
    throughExecutionRowid: input.throughExecutionRowid,
    git: input.git,
    exports: input.exports,
  });
const fail: (message: string) => never = (message) => {
  throw new Error(`Invalid team deletion: ${message}`);
};
function decode(db: Db, row: DeletionRow): TeamDeletionRecord {
  const captured = Captured.parse(JSON.parse(row.captured_input));
  const identity = Identity.parse({ id: row.id, threadId: row.thread_id, instanceId: row.instance_id, projectId: row.project_id, requestKey: row.request_key, requestHash: row.request_hash });
  const items = (db.stmt("SELECT item_index,state,updated_at FROM team_deletion_items WHERE deletion_id=? ORDER BY item_index").all(row.id) as unknown as ItemRow[]).map((item) => ({
    index: timestamp.parse(item.item_index),
    state: z.enum(["pending", "quarantined", "removed"]).parse(item.state),
    updatedAt: timestamp.parse(item.updated_at),
  }));
  if (items.length !== captured.entries.length || items.some((item, index) => item.index !== index || item.updatedAt < row.created_at))
    fail("cleanup progress does not match its immutable inventory; preserve the journal for recovery.");
  const state = z.enum(["pending", "attention", "applied"]).parse(row.state);
  if (
    row.updated_at < row.created_at ||
    (state === "attention") !== Boolean(row.error) ||
    (state === "applied" && items.some((item) => item.state !== "removed")) ||
    (state === "applied" && captured.retainedTaskIds.length > 0 !== Boolean(row.applied_context_id)) ||
    (state !== "applied" && row.applied_context_id !== null)
  )
    fail("receipt outcome does not match its retained cleanup or context.");
  return {
    ...identity,
    ...captured,
    state: row.cancelled_at == null ? state : "cancelled",
    items,
    appliedContextId: row.applied_context_id,
    error: row.error,
    createdAt: timestamp.parse(row.created_at),
    updatedAt: timestamp.parse(row.updated_at),
  };
}
function required(db: Db, deletionId: string): TeamDeletionRecord {
  return teamDeletions.get(db, deletionId) ?? fail("recovery intent was not found.");
}
function marker(row: DeletedRow): TeamDeletedThread {
  return {
    threadId: id.parse(row.thread_id),
    instanceId: id.parse(row.instance_id),
    deletedAt: timestamp.parse(row.deleted_at),
    contextCheckpointId: id.parse(row.context_checkpoint_id),
    throughExecutionRowid: timestamp.parse(row.through_execution_rowid),
  };
}
function assertOwner(db: Db, input: CreateTeamDeletionInput): void {
  const owner = db
    .stmt(
      `SELECT i.id FROM orchestration_team_instances i JOIN threads t ON t.id=i.thread_id JOIN projects p ON p.id=t.project_id
    WHERE t.id=? AND i.id=? AND p.id=? AND p.root_path=?`,
    )
    .get(input.threadId, input.instanceId, input.projectId, input.projectRoot);
  if (!owner) fail("intent must retain its exact thread, instance and project.");
  const ids = (db.stmt("SELECT id FROM tasks WHERE thread_id=? ORDER BY id").all(input.threadId) as { id: string }[]).map((item) => item.id);
  const deleted = input.deletedTaskIds ?? [];
  if (JSON.stringify(ids) !== JSON.stringify([...input.retainedTaskIds, ...deleted].sort())) fail("retained and deleted tasks together must match every current task of this conversation.");
  // Only a hidden owner deletes its tasks, and only all of them at once; a visible owner retains them.
  if (teamDeletedThreads.has(db, input.threadId) ? input.retainedTaskIds.length > 0 || deleted.length === 0 : deleted.length > 0)
    fail("a deleted conversation's saved tasks are deleted together; an ordinary conversation retains its tasks.");
  const high = db.stmt("SELECT COALESCE(MAX(rowid),0) AS value FROM team_executions WHERE thread_id=?").get(input.threadId) as { value: number };
  if (high.value !== input.throughExecutionRowid) fail("execution history changed after the deletion boundary was captured.");
}

/** Internal ownership remains readable; public conversation queries exclude these immutable markers. */
export const teamDeletedThreads = {
  /** Cheap visibility check used by every public conversation read. */
  has(db: Db, threadId: string): boolean {
    return Boolean(db.stmt("SELECT 1 FROM team_deleted_threads WHERE thread_id=?").get(threadId));
  },
  get(db: Db, threadId: string): TeamDeletedThread | null {
    const row = db.stmt("SELECT * FROM team_deleted_threads WHERE thread_id=?").get(threadId) as unknown as DeletedRow | undefined;
    return row ? marker(row) : null;
  },
  list(db: Db): TeamDeletedThread[] {
    return (db.stmt("SELECT * FROM team_deleted_threads ORDER BY deleted_at,rowid").all() as unknown as DeletedRow[]).map(marker);
  },
};

/** Retained independently of owner deletion so acknowledgement loss cannot recreate cleanup. */
export const teamDeletions = {
  cancel(db: Db, id: string): TeamDeletionRecord {
    return db.transaction(() => {
      const record = required(db, id);
      if (record.state === "cancelled") return record;
      if (record.state === "applied") throw new Error("This operation already finished.");
      db.stmt("UPDATE team_deletions SET cancelled_at=? WHERE id=?").run(Math.max(Date.now(), record.updatedAt), id);
      return required(db, id);
    });
  },
  get(db: Db, deletionId: string): TeamDeletionRecord | null {
    const row = db.stmt("SELECT * FROM team_deletions WHERE id=?").get(deletionId) as unknown as DeletionRow | undefined;
    return row ? decode(db, row) : null;
  },
  find(db: Db, threadId: string, requestKey: string): TeamDeletionRecord | null {
    const row = db.stmt("SELECT * FROM team_deletions WHERE thread_id=? AND request_key=?").get(threadId, requestKey) as unknown as DeletionRow | undefined;
    return row ? decode(db, row) : null;
  },
  list(db: Db): TeamDeletionRecord[] {
    return (db.stmt("SELECT * FROM team_deletions ORDER BY created_at,rowid").all() as unknown as DeletionRow[]).map((row) => decode(db, row));
  },
  pending(db: Db, threadId?: string): TeamDeletionRecord[] {
    const sql = "SELECT * FROM team_deletions WHERE state<>'applied' AND cancelled_at IS NULL" + (threadId === undefined ? "" : " AND thread_id=?") + " ORDER BY created_at,rowid";
    return (db.stmt(sql).all(...(threadId === undefined ? [] : [threadId])) as unknown as DeletionRow[]).map((row) => decode(db, row));
  },
  pendingForThread(db: Db, threadId: string): TeamDeletionRecord[] {
    return teamDeletions.pending(db, threadId);
  },
  create(db: Db, input: CreateTeamDeletionInput): TeamDeletionRecord {
    const identity = Identity.parse(input),
      captured = capture(input);
    return db.transaction(() => {
      const prior = teamDeletions.find(db, input.threadId, input.requestKey);
      if (prior) {
        if (JSON.stringify(Identity.parse(prior)) !== JSON.stringify(identity) || JSON.stringify(capture(prior)) !== JSON.stringify(captured))
          fail("this request already identifies different captured work.");
        return prior;
      }
      assertOwner(db, input);
      const now = Date.now();
      db.stmt(
        `INSERT INTO team_deletions(id,thread_id,instance_id,project_id,request_key,request_hash,captured_input,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'pending',?,?)`,
      ).run(identity.id, identity.threadId, identity.instanceId, identity.projectId, identity.requestKey, identity.requestHash, JSON.stringify(captured), now, now);
      for (let index = 0; index < captured.entries.length; index++)
        db.stmt("INSERT INTO team_deletion_items(deletion_id,item_index,state,updated_at) VALUES(?,?,'pending',?)").run(identity.id, index, now);
      return required(db, identity.id);
    });
  },
  attention(db: Db, deletionId: string, error: string): TeamDeletionRecord {
    id.parse(error);
    const record = required(db, deletionId);
    if (record.state === "applied") fail("this deletion is already applied.");
    db.stmt("UPDATE team_deletions SET state='attention',error=?,updated_at=? WHERE id=?").run(error, Math.max(Date.now(), record.updatedAt), deletionId);
    return required(db, deletionId);
  },
  markItem(db: Db, deletionId: string, index: number, state: TeamCleanupPhase): TeamDeletionRecord {
    timestamp.parse(index);
    z.enum(["pending", "quarantined", "removed"]).parse(state);
    return db.transaction(() => {
      const record = required(db, deletionId),
        item = record.items[index];
      if (!item) fail("cleanup item does not belong to this inventory.");
      if (item.state === state) return record;
      if (record.state === "applied") fail("this deletion is already applied.");
      const now = Math.max(Date.now(), record.updatedAt, item.updatedAt);
      db.stmt("UPDATE team_deletion_items SET state=?,updated_at=? WHERE deletion_id=? AND item_index=?").run(state, now, deletionId, index);
      db.stmt("UPDATE team_deletions SET updated_at=? WHERE id=?").run(now, deletionId);
      return required(db, deletionId);
    });
  },
  finish(db: Db, deletionId: string, input: { contextCheckpointId?: string } = {}): TeamDeletionRecord {
    return db.transaction(() => {
      const record = required(db, deletionId),
        contextId = input.contextCheckpointId ?? null;
      if (record.state === "applied") {
        if (record.appliedContextId !== contextId) fail("this deletion was applied with a different context.");
        return record;
      }
      if (record.items.some((item) => item.state !== "removed")) fail("every cleanup item must be confirmed removed before deletion finishes.");
      const now = Math.max(Date.now(), record.updatedAt);
      if (record.retainedTaskIds.length) {
        assertOwner(db, record);
        if (!contextId) fail("retained tasks require their exact fresh context boundary.");
        db.stmt("INSERT INTO team_deleted_threads(thread_id,instance_id,deleted_at,context_checkpoint_id,through_execution_rowid) VALUES(?,?,?,?,?)").run(
          record.threadId,
          record.instanceId,
          now,
          contextId,
          record.throughExecutionRowid,
        );
      } else if (contextId || db.stmt("SELECT 1 FROM threads WHERE id=?").get(record.threadId) || record.deletedTaskIds.some((taskId) => db.stmt("SELECT 1 FROM tasks WHERE id=?").get(taskId)))
        fail("cleanup must remove its owner and any deleted tasks before finishing and must not create context.");
      db.stmt("UPDATE team_deletions SET state='applied',applied_context_id=?,error=NULL,updated_at=? WHERE id=?").run(contextId, now, deletionId);
      return required(db, deletionId);
    });
  },
  rejection(db: Db, threadId: string, requestKey: string): TeamDeletionRejection | null {
    const row = db.stmt("SELECT * FROM team_deletion_rejections WHERE thread_id=? AND request_key=?").get(threadId, requestKey) as unknown as RejectionRow | undefined;
    return row
      ? {
          threadId: id.parse(row.thread_id),
          requestKey: id.max(200).parse(row.request_key),
          requestHash: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .parse(row.request_hash),
          error: id.parse(row.error),
          createdAt: timestamp.parse(row.created_at),
        }
      : null;
  },
  reject(db: Db, input: Omit<TeamDeletionRejection, "createdAt">): TeamDeletionRejection {
    id.parse(input.threadId);
    id.max(200).parse(input.requestKey);
    id.parse(input.error);
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(input.requestHash);
    return db.transaction(() => {
      const prior = teamDeletions.rejection(db, input.threadId, input.requestKey);
      if (prior) {
        if (prior.requestHash !== input.requestHash || prior.error !== input.error) fail("this request already identifies a different rejection.");
        return prior;
      }
      const createdAt = Date.now();
      db.stmt("INSERT INTO team_deletion_rejections(thread_id,request_key,request_hash,error,created_at) VALUES(?,?,?,?,?)").run(
        input.threadId,
        input.requestKey,
        input.requestHash,
        input.error,
        createdAt,
      );
      return { ...input, createdAt };
    });
  },
};
