import path from "node:path";
import { ExecutableAgent, LeadOverrides, TeamContextSeed, TeamTreeCapture, Thread } from "@openorc/protocol";
import { z } from "zod";
import type { Db } from "./database.js";

export type TeamForkThread = Pick<Thread, "title" | "agent" | "model" | "effort" | "fastMode" | "mode" | "permissionMode">;
export interface CreateTeamForkInput {
  id: string;
  sourceThreadId: string;
  sourceInstanceId: string;
  projectId: string;
  projectRoot: string;
  requestKey: string;
  requestHash: string;
  destinationThreadId: string;
  snapshot: TeamTreeCapture;
  setupInput: TeamTreeCapture | null;
  seed: string;
  sourceRunId: string | null;
  upToRunId: string | null;
  teamRevisionId: string;
  checkoutBaseTree?: string | null;
  leadOverrides: LeadOverrides;
  thread: TeamForkThread;
}
export interface TeamForkRecord extends CreateTeamForkInput {
  state: "pending" | "attention" | "applied" | "cancelled";
  paths: string[];
  appliedPath: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface TeamForkRejection {
  sourceThreadId: string;
  requestKey: string;
  requestHash: string;
  error: string;
  createdAt: number;
}
interface RejectionRow {
  source_thread_id: string;
  request_key: string;
  request_hash: string;
  error: string;
  created_at: number;
}
interface ForkRow {
  cancelled_at: number | null;
  id: string;
  source_thread_id: string;
  source_instance_id: string;
  project_id: string;
  request_key: string;
  request_hash: string;
  destination_thread_id: string;
  captured_input: string;
  state: TeamForkRecord["state"];
  paths: string;
  applied_path: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}
const ThreadInput = Thread.pick({ title: true, agent: true, model: true, effort: true, fastMode: true, mode: true, permissionMode: true }).extend({ agent: ExecutableAgent });
const CapturedInput = z.object({
  projectRoot: z.string().min(1),
  snapshot: TeamTreeCapture,
  checkoutBaseTree: TeamTreeCapture.shape.treeSha.nullable().optional(),
  setupInput: TeamTreeCapture.nullable(),
  seed: TeamContextSeed,
  sourceRunId: z.string().nullable(),
  upToRunId: z.string().nullable(),
  teamRevisionId: z.string().min(1),
  leadOverrides: LeadOverrides,
  thread: ThreadInput,
});
const candidatePaths = z.array(z.string().refine((value) => path.isAbsolute(value) && path.normalize(value) === value));
const captures = (input: CreateTeamForkInput) =>
  CapturedInput.parse({
    projectRoot: input.projectRoot,
    snapshot: input.snapshot,
    checkoutBaseTree: input.checkoutBaseTree == null ? null : TeamTreeCapture.shape.treeSha.parse(input.checkoutBaseTree),
    setupInput: input.setupInput,
    seed: input.seed,
    sourceRunId: input.sourceRunId,
    upToRunId: input.upToRunId,
    teamRevisionId: input.teamRevisionId,
    leadOverrides: input.leadOverrides,
    thread: input.thread,
  });
function decode(row: ForkRow): TeamForkRecord {
  try {
    return {
      id: row.id,
      sourceThreadId: row.source_thread_id,
      sourceInstanceId: row.source_instance_id,
      projectId: row.project_id,
      requestKey: row.request_key,
      requestHash: row.request_hash,
      destinationThreadId: row.destination_thread_id,
      ...CapturedInput.parse(JSON.parse(row.captured_input)),
      state: row.cancelled_at == null ? row.state : "cancelled",
      paths: candidatePaths.parse(JSON.parse(row.paths)),
      appliedPath: row.applied_path,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } catch (cause) {
    throw new Error(`Fork recovery intent ${row.id} could not be read. Preserve the database for recovery.`, { cause });
  }
}
function required(db: Db, id: string): TeamForkRecord {
  const record = teamForks.get(db, id);
  if (!record) throw new Error("Fork recovery intent was not found.");
  return record;
}

export const teamForks = {
  cancel(db: Db, id: string): TeamForkRecord {
    return db.transaction(() => {
      const record = required(db, id);
      if (record.state === "cancelled") return record;
      if (record.state === "applied") throw new Error("This operation already finished.");
      db.stmt("UPDATE team_forks SET cancelled_at=? WHERE id=?").run(Math.max(Date.now(), record.updatedAt), id);
      return required(db, id);
    });
  },
  rejection(db: Db, sourceThreadId: string, requestKey: string): TeamForkRejection | null {
    const row = db.stmt("SELECT * FROM team_fork_rejections WHERE source_thread_id=? AND request_key=?").get(sourceThreadId, requestKey) as unknown as RejectionRow | undefined;
    return row ? { sourceThreadId: row.source_thread_id, requestKey: row.request_key, requestHash: row.request_hash, error: row.error, createdAt: row.created_at } : null;
  },
  reject(db: Db, input: Omit<TeamForkRejection, "createdAt">): TeamForkRejection {
    if (!input.sourceThreadId.trim() || !input.requestKey.trim() || input.requestKey.length > 200 || !/^[a-f0-9]{64}$/.test(input.requestHash) || !input.error.trim())
      throw new Error("Fork rejection needs a bounded request identity, fingerprint and error description.");
    return db.transaction(() => {
      const previous = teamForks.rejection(db, input.sourceThreadId, input.requestKey);
      if (previous) {
        if (previous.requestHash !== input.requestHash || previous.error !== input.error) throw new Error("This fork request already identifies a different rejection.");
        return previous;
      }
      const createdAt = Date.now();
      db.stmt("INSERT INTO team_fork_rejections(source_thread_id,request_key,request_hash,error,created_at) VALUES(?,?,?,?,?)").run(
        input.sourceThreadId,
        input.requestKey,
        input.requestHash,
        input.error,
        createdAt,
      );
      return { ...input, createdAt };
    });
  },
  get(db: Db, id: string): TeamForkRecord | null {
    const row = db.stmt("SELECT * FROM team_forks WHERE id=?").get(id) as unknown as ForkRow | undefined;
    return row ? decode(row) : null;
  },
  find(db: Db, sourceThreadId: string, requestKey: string): TeamForkRecord | null {
    const row = db.stmt("SELECT * FROM team_forks WHERE source_thread_id=? AND request_key=?").get(sourceThreadId, requestKey) as unknown as ForkRow | undefined;
    return row ? decode(row) : null;
  },
  byDestinationThread(db: Db, threadId: string): TeamForkRecord | null {
    const row = db.stmt("SELECT * FROM team_forks WHERE destination_thread_id=? AND state='applied'").get(threadId) as unknown as ForkRow | undefined;
    return row ? decode(row) : null;
  },
  pendingForThread(db: Db, threadId: string): TeamForkRecord[] {
    return (
      db
        .stmt("SELECT * FROM team_forks WHERE state<>'applied' AND cancelled_at IS NULL AND (source_thread_id=? OR destination_thread_id=?) ORDER BY created_at,rowid")
        .all(threadId, threadId) as unknown as ForkRow[]
    ).map(decode);
  },
  list(db: Db): TeamForkRecord[] {
    return (db.stmt("SELECT * FROM team_forks ORDER BY created_at,rowid").all() as unknown as ForkRow[]).map(decode);
  },
  create(db: Db, input: CreateTeamForkInput): TeamForkRecord {
    if (
      [input.id, input.sourceThreadId, input.sourceInstanceId, input.projectId, input.destinationThreadId, input.teamRevisionId, input.requestKey].some((value) => !value.trim()) ||
      input.requestKey.length > 200 ||
      !/^[a-f0-9]{64}$/.test(input.requestHash) ||
      !path.isAbsolute(input.projectRoot) ||
      (input.sourceRunId !== null && !input.sourceRunId.trim()) ||
      (input.upToRunId !== null && (!input.upToRunId.trim() || input.upToRunId !== input.sourceRunId))
    )
      throw new Error("Fork intent needs bounded identities, a request fingerprint, matching cutoff and absolute project root.");
    const captured = captures(input);
    if (!captured.seed.trim() || !path.isAbsolute(captured.snapshot.rootPath) || (captured.setupInput && !path.isAbsolute(captured.setupInput.rootPath)))
      throw new Error("Fork intent needs retained context and absolute snapshot sources.");
    return db.transaction(() => {
      const previous = teamForks.find(db, input.sourceThreadId, input.requestKey);
      if (previous) {
        if (
          previous.id !== input.id ||
          previous.sourceInstanceId !== input.sourceInstanceId ||
          previous.projectId !== input.projectId ||
          previous.requestHash !== input.requestHash ||
          previous.destinationThreadId !== input.destinationThreadId ||
          JSON.stringify(captures(previous)) !== JSON.stringify(captured)
        )
          throw new Error("This fork request already identifies different captured work.");
        return previous;
      }
      const now = Date.now();
      db.stmt(
        `INSERT INTO team_forks(id,source_thread_id,source_instance_id,project_id,request_key,request_hash,destination_thread_id,captured_input,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,'pending',?,?)`,
      ).run(input.id, input.sourceThreadId, input.sourceInstanceId, input.projectId, input.requestKey, input.requestHash, input.destinationThreadId, JSON.stringify(captured), now, now);
      return required(db, input.id);
    });
  },
  appendPath(db: Db, id: string, candidate: string): TeamForkRecord {
    if (!path.isAbsolute(candidate) || path.normalize(candidate) !== candidate) throw new Error("A fork candidate needs a normalized absolute path.");
    return db.transaction(() => {
      const record = required(db, id);
      if (record.state === "applied") throw new Error("This fork is already applied.");
      if (db.stmt("SELECT 1 FROM team_forks f,json_each(f.paths) p WHERE p.value=?").get(candidate)) throw new Error("This fork candidate was already reserved. Recovery requires a new path.");
      db.stmt("UPDATE team_forks SET paths=?,updated_at=? WHERE id=?").run(JSON.stringify([...record.paths, candidate]), Math.max(Date.now(), record.updatedAt), id);
      return required(db, id);
    });
  },
  attention(db: Db, id: string, error: string): TeamForkRecord {
    if (!error.trim()) throw new Error("Fork recovery needs an error description.");
    const record = required(db, id);
    if (record.state === "applied") throw new Error("This fork is already applied.");
    db.stmt("UPDATE team_forks SET state='attention',error=?,updated_at=? WHERE id=?").run(error, Math.max(Date.now(), record.updatedAt), id);
    return required(db, id);
  },
  apply(db: Db, id: string, appliedPath: string): TeamForkRecord {
    return db.transaction(() => {
      const record = required(db, id);
      if (record.state === "applied") {
        if (record.appliedPath !== appliedPath) throw new Error("This fork was already applied to a different workspace.");
        return record;
      }
      if (!record.paths.length || record.paths.at(-1) !== appliedPath) throw new Error("Apply only the newest reserved fork candidate.");
      db.stmt("UPDATE team_forks SET state='applied',applied_path=?,error=NULL,updated_at=? WHERE id=?").run(appliedPath, Math.max(Date.now(), record.updatedAt), id);
      return required(db, id);
    });
  },
};
