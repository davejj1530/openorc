import path from "node:path";
import { TeamContextSeed, TeamTreeCapture } from "@openorc/protocol";
import { z } from "zod";
import type { Db } from "./database.js";

export interface CreateTeamRestoreInput {
  id: string;
  threadId: string;
  instanceId: string;
  projectId: string;
  projectRoot: string;
  requestKey: string;
  requestHash: string;
  checkpointId: string;
  sourceRunId: string | null;
  before: TeamTreeCapture;
  targetTree: string;
  setupInput: TeamTreeCapture | null;
  seed: string;
  sourcePath: string;
}
export interface TeamRestoreRecord extends CreateTeamRestoreInput {
  state: "pending" | "attention" | "applied" | "cancelled";
  paths: string[];
  appliedPath: string | null;
  appliedContextId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface TeamRestoreRejection {
  threadId: string;
  requestKey: string;
  requestHash: string;
  error: string;
  createdAt: number;
}
interface RejectionRow {
  thread_id: string;
  request_key: string;
  request_hash: string;
  error: string;
  created_at: number;
}
interface RestoreRow {
  cancelled_at: number | null;
  id: string;
  thread_id: string;
  instance_id: string;
  project_id: string;
  request_key: string;
  request_hash: string;
  captured_input: string;
  state: TeamRestoreRecord["state"];
  paths: string;
  applied_path: string | null;
  applied_context_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}
const CapturedInput = z.object({
  projectRoot: z.string().min(1),
  checkpointId: z.string().min(1),
  sourceRunId: z.string().nullable(),
  before: TeamTreeCapture,
  targetTree: TeamTreeCapture.shape.treeSha,
  setupInput: TeamTreeCapture.nullable(),
  seed: TeamContextSeed,
  sourcePath: z.string().min(1),
});
const candidatePaths = z.array(z.string().refine((value) => path.isAbsolute(value) && path.normalize(value) === value));
const captures = (input: CreateTeamRestoreInput) =>
  CapturedInput.parse({
    projectRoot: input.projectRoot,
    checkpointId: input.checkpointId,
    sourceRunId: input.sourceRunId,
    before: input.before,
    targetTree: input.targetTree,
    setupInput: input.setupInput,
    seed: input.seed,
    sourcePath: input.sourcePath,
  });
function decode(row: RestoreRow): TeamRestoreRecord {
  try {
    return {
      id: row.id,
      threadId: row.thread_id,
      instanceId: row.instance_id,
      projectId: row.project_id,
      requestKey: row.request_key,
      requestHash: row.request_hash,
      ...CapturedInput.parse(JSON.parse(row.captured_input)),
      state: row.cancelled_at == null ? row.state : "cancelled",
      paths: candidatePaths.parse(JSON.parse(row.paths)),
      appliedPath: row.applied_path,
      appliedContextId: row.applied_context_id,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } catch (cause) {
    throw new Error(`Restore recovery intent ${row.id} could not be read. Preserve the database for recovery.`, { cause });
  }
}
function required(db: Db, id: string): TeamRestoreRecord {
  const record = teamRestores.get(db, id);
  if (!record) throw new Error("Restore recovery intent was not found.");
  return record;
}
const absolute = (value: string) => path.isAbsolute(value) && path.normalize(value) === value;

export const teamRestores = {
  cancel(db: Db, id: string): TeamRestoreRecord {
    return db.transaction(() => {
      const record = required(db, id);
      if (record.state === "cancelled") return record;
      if (record.state === "applied") throw new Error("This operation already finished.");
      db.stmt("UPDATE team_restores SET cancelled_at=? WHERE id=?").run(Math.max(Date.now(), record.updatedAt), id);
      return required(db, id);
    });
  },
  rejection(db: Db, threadId: string, requestKey: string): TeamRestoreRejection | null {
    const row = db.stmt("SELECT * FROM team_restore_rejections WHERE thread_id=? AND request_key=?").get(threadId, requestKey) as unknown as RejectionRow | undefined;
    return row ? { threadId: row.thread_id, requestKey: row.request_key, requestHash: row.request_hash, error: row.error, createdAt: row.created_at } : null;
  },
  reject(db: Db, input: Omit<TeamRestoreRejection, "createdAt">): TeamRestoreRejection {
    if (!input.threadId.trim() || !input.requestKey.trim() || input.requestKey.length > 200 || !/^[a-f0-9]{64}$/.test(input.requestHash) || !input.error.trim()) {
      throw new Error("Restore rejection needs a bounded request identity, fingerprint and error description.");
    }
    return db.transaction(() => {
      const previous = teamRestores.rejection(db, input.threadId, input.requestKey);
      if (previous) {
        if (previous.requestHash !== input.requestHash || previous.error !== input.error) throw new Error("This restore request already identifies a different rejection.");
        return previous;
      }
      const createdAt = Date.now();
      db.stmt("INSERT INTO team_restore_rejections(thread_id,request_key,request_hash,error,created_at) VALUES(?,?,?,?,?)").run(
        input.threadId,
        input.requestKey,
        input.requestHash,
        input.error,
        createdAt,
      );
      return { ...input, createdAt };
    });
  },
  get(db: Db, id: string): TeamRestoreRecord | null {
    const row = db.stmt("SELECT * FROM team_restores WHERE id=?").get(id) as unknown as RestoreRow | undefined;
    return row ? decode(row) : null;
  },
  find(db: Db, threadId: string, requestKey: string): TeamRestoreRecord | null {
    const row = db.stmt("SELECT * FROM team_restores WHERE thread_id=? AND request_key=?").get(threadId, requestKey) as unknown as RestoreRow | undefined;
    return row ? decode(row) : null;
  },
  latestForThread(db: Db, threadId: string): TeamRestoreRecord | null {
    const row = db
      .stmt(
        "SELECT r.* FROM team_restores r LEFT JOIN team_context_checkpoints c ON c.id=r.applied_context_id WHERE r.thread_id=? AND r.state='applied' ORDER BY c.epoch DESC,r.updated_at DESC,r.rowid DESC LIMIT 1",
      )
      .get(threadId) as unknown as RestoreRow | undefined;
    return row ? decode(row) : null;
  },
  forThread(db: Db, threadId: string): TeamRestoreRecord[] {
    return (db.stmt("SELECT * FROM team_restores WHERE thread_id=? ORDER BY created_at,rowid").all(threadId) as unknown as RestoreRow[]).map(decode);
  },
  pendingForThread(db: Db, threadId: string): TeamRestoreRecord[] {
    return (db.stmt("SELECT * FROM team_restores WHERE thread_id=? AND state<>'applied' AND cancelled_at IS NULL ORDER BY created_at,rowid").all(threadId) as unknown as RestoreRow[]).map(decode);
  },
  list(db: Db): TeamRestoreRecord[] {
    return (db.stmt("SELECT * FROM team_restores ORDER BY created_at,rowid").all() as unknown as RestoreRow[]).map(decode);
  },
  create(db: Db, input: CreateTeamRestoreInput): TeamRestoreRecord {
    if (
      [input.id, input.threadId, input.instanceId, input.projectId, input.checkpointId, input.requestKey].some((value) => !value.trim()) ||
      input.requestKey.length > 200 ||
      !/^[a-f0-9]{64}$/.test(input.requestHash) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.targetTree) ||
      !absolute(input.projectRoot) ||
      !absolute(input.sourcePath) ||
      (input.sourceRunId !== null && !input.sourceRunId.trim())
    ) {
      throw new Error("Restore intent needs bounded identities, a request fingerprint, target tree and absolute source paths.");
    }
    const captured = captures(input);
    if (!captured.seed.trim() || !absolute(captured.before.rootPath) || (captured.setupInput && captured.setupInput.rootPath !== captured.before.rootPath)) {
      throw new Error("Restore intent needs retained context and absolute snapshot source paths.");
    }
    return db.transaction(() => {
      const previous = teamRestores.find(db, input.threadId, input.requestKey);
      if (previous) {
        if (
          previous.id !== input.id ||
          previous.instanceId !== input.instanceId ||
          previous.projectId !== input.projectId ||
          previous.requestHash !== input.requestHash ||
          JSON.stringify(captures(previous)) !== JSON.stringify(captured)
        ) {
          throw new Error("This restore request already identifies different captured work.");
        }
        return previous;
      }
      const now = Date.now();
      db.stmt(
        `INSERT INTO team_restores(id,thread_id,instance_id,project_id,request_key,request_hash,captured_input,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'pending',?,?)`,
      ).run(input.id, input.threadId, input.instanceId, input.projectId, input.requestKey, input.requestHash, JSON.stringify(captured), now, now);
      return required(db, input.id);
    });
  },
  appendPath(db: Db, id: string, candidate: string): TeamRestoreRecord {
    if (!absolute(candidate)) throw new Error("A restore candidate needs a normalized absolute path.");
    return db.transaction(() => {
      const record = required(db, id);
      if (record.state === "applied") throw new Error("This restore is already applied.");
      if (candidate === record.sourcePath || candidate === record.projectRoot) throw new Error("Restore must preserve the original workspace in a separate path.");
      if (db.stmt("SELECT 1 FROM team_restores r,json_each(r.paths) p WHERE p.value=?").get(candidate)) {
        throw new Error("This restore candidate was already reserved. Recovery requires a new path.");
      }
      db.stmt("UPDATE team_restores SET paths=?,updated_at=? WHERE id=?").run(JSON.stringify([...record.paths, candidate]), Math.max(Date.now(), record.updatedAt), id);
      return required(db, id);
    });
  },
  attention(db: Db, id: string, error: string): TeamRestoreRecord {
    if (!error.trim()) throw new Error("Restore recovery needs an error description.");
    const record = required(db, id);
    if (record.state === "applied") throw new Error("This restore is already applied.");
    db.stmt("UPDATE team_restores SET state='attention',error=?,updated_at=? WHERE id=?").run(error, Math.max(Date.now(), record.updatedAt), id);
    return required(db, id);
  },
  apply(db: Db, id: string, input: { path: string; contextCheckpointId: string }): TeamRestoreRecord {
    return db.transaction(() => {
      const record = required(db, id);
      if (record.state === "applied") {
        if (record.appliedPath !== input.path || record.appliedContextId !== input.contextCheckpointId) throw new Error("This restore was already applied to a different workspace or context.");
        return record;
      }
      if (!record.paths.length || record.paths.at(-1) !== input.path) throw new Error("Apply only the newest reserved restore candidate.");
      db.stmt("UPDATE team_restores SET state='applied',applied_path=?,applied_context_id=?,error=NULL,updated_at=? WHERE id=?").run(
        input.path,
        input.contextCheckpointId,
        Math.max(Date.now(), record.updatedAt),
        id,
      );
      return required(db, id);
    });
  },
};
