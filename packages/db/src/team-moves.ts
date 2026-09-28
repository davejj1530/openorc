import path from "node:path";
import { z } from "zod";
import { TeamContextSeed, TeamTreeCapture, TeamTreeEntry } from "@openorc/protocol";
import type { Db } from "./database.js";
import { teamWorkspaces } from "./team-workspaces.js";

const id = z
  .string()
  .min(1)
  .refine((value) => Boolean(value.trim()), "An identity must not be blank.");
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const absolute = id.refine((value) => path.isAbsolute(value) && path.normalize(value) === value, "A workspace path must be normalized and absolute.");
const relative = id.refine(
  (value) => !path.isAbsolute(value) && !value.includes("\0") && value.split("/").every((part) => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git"),
  "A publication path must stay inside its workspace.",
);
const mode = z.enum(["current", "worktree"]);
const CapturedInput = z
  .object({
    projectRoot: absolute,
    from: mode,
    to: mode,
    sourcePath: absolute,
    source: TeamTreeCapture,
    setupInput: TeamTreeCapture.nullable(),
    destinationBefore: TeamTreeCapture.nullable(),
    deltas: z.array(z.object({ baseTree: sha, outputTree: sha })).max(1000),
    originMoveId: id.nullable(),
    publicationBranch: id.nullable(),
    seed: TeamContextSeed,
  })
  .superRefine((input, context) => {
    if (input.from === input.to || (input.to === "current") !== (input.destinationBefore !== null) || (input.from !== "current" && input.originMoveId !== null))
      context.addIssue({ code: "custom", message: "A move needs opposite modes and the current destination capture; only a local source can have a return origin." });
    for (const snapshot of [input.source, input.setupInput, input.destinationBefore])
      if (snapshot && !absolute.safeParse(snapshot.rootPath).success) context.addIssue({ code: "custom", message: "Move captures need absolute physical roots." });
    if (input.setupInput && input.setupInput.rootPath !== input.source.rootPath) context.addIssue({ code: "custom", message: "Setup input must belong to the captured source." });
    if (!input.seed.trim()) context.addIssue({ code: "custom", message: "A move needs retained context." });
  });
const Publication = z
  .object({ afterTree: sha, entries: z.array(z.object({ path: relative, before: TeamTreeEntry.nullable(), after: TeamTreeEntry.nullable() })).max(100_000) })
  .superRefine((value, context) => {
    if (
      new Set(value.entries.map((entry) => entry.path)).size !== value.entries.length ||
      value.entries.some((entry) => (!entry.before && !entry.after) || (entry.before && entry.before.path !== entry.path) || (entry.after && entry.after.path !== entry.path))
    ) {
      context.addIssue({ code: "custom", message: "Publication entries require unique exact before/after paths." });
    }
  });
const Candidate = z.object({ path: absolute, kind: z.enum(["scratch", "workspace"]) });
export type TeamMovePublication = z.infer<typeof Publication>;
export type TeamMovePath = z.infer<typeof Candidate>;
export type CreateTeamMoveInput = z.infer<typeof CapturedInput> & {
  id: string;
  threadId: string;
  instanceId: string;
  projectId: string;
  requestKey: string;
  requestHash: string;
};
export interface TeamMoveRecord extends CreateTeamMoveInput {
  state: "pending" | "attention" | "applied" | "cancelled";
  paths: TeamMovePath[];
  publication: TeamMovePublication | null;
  afterTree: string | null;
  cancelRequested: boolean;
  appliedPath: string | null;
  appliedContextId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface TeamMoveRejection {
  threadId: string;
  requestKey: string;
  requestHash: string;
  error: string;
  createdAt: number;
}
interface MoveRow {
  id: string;
  thread_id: string;
  instance_id: string;
  project_id: string;
  request_key: string;
  request_hash: string;
  captured_input: string;
  state: TeamMoveRecord["state"];
  paths: string;
  publication: string | null;
  after_tree: string | null;
  cancel_requested: number;
  applied_path: string | null;
  applied_context_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}
interface RejectionRow {
  thread_id: string;
  request_key: string;
  request_hash: string;
  error: string;
  created_at: number;
}
const identity = z.object({ id, threadId: id, instanceId: id, projectId: id, requestKey: id.max(200), requestHash: z.string().regex(/^[a-f0-9]{64}$/) });
function decode(row: MoveRow): TeamMoveRecord {
  const capture = CapturedInput.parse(JSON.parse(row.captured_input));
  const record = {
    ...identity.parse({ id: row.id, threadId: row.thread_id, instanceId: row.instance_id, projectId: row.project_id, requestKey: row.request_key, requestHash: row.request_hash }),
    ...capture,
    state: row.state,
    paths: z.array(Candidate).parse(JSON.parse(row.paths)),
    publication: row.publication === null ? null : Publication.parse(JSON.parse(row.publication)),
    afterTree: row.after_tree,
    cancelRequested: row.cancel_requested === 1,
    appliedPath: row.applied_path,
    appliedContextId: row.applied_context_id,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (record.publication ? record.afterTree !== (record.to === "current" ? record.publication.afterTree : record.source.treeSha) : record.afterTree !== null)
    throw new Error("Move publication and result tree disagree. Preserve the journal for recovery.");
  return record;
}
function required(db: Db, moveId: string): TeamMoveRecord {
  const record = teamMoves.get(db, moveId);
  if (!record) throw new Error("Move recovery intent was not found.");
  return record;
}
const terminal = (record: TeamMoveRecord) => record.state === "applied" || record.state === "cancelled";
const updated = (record: TeamMoveRecord) => Math.max(Date.now(), record.updatedAt);

/** Retained inputs and a verified publication plan outlive every workspace pointer. */
export const teamMoves = {
  get(db: Db, moveId: string): TeamMoveRecord | null {
    const row = db.stmt("SELECT * FROM team_moves WHERE id=?").get(moveId) as unknown as MoveRow | undefined;
    return row ? decode(row) : null;
  },
  find(db: Db, threadId: string, requestKey: string): TeamMoveRecord | null {
    const row = db.stmt("SELECT * FROM team_moves WHERE thread_id=? AND request_key=?").get(threadId, requestKey) as unknown as MoveRow | undefined;
    return row ? decode(row) : null;
  },
  list(db: Db): TeamMoveRecord[] {
    return (db.stmt("SELECT * FROM team_moves ORDER BY created_at,rowid").all() as unknown as MoveRow[]).map(decode);
  },
  forThread(db: Db, threadId: string): TeamMoveRecord[] {
    return (db.stmt("SELECT * FROM team_moves WHERE thread_id=? ORDER BY created_at,rowid").all(threadId) as unknown as MoveRow[]).map(decode);
  },
  pendingForThread(db: Db, threadId: string): TeamMoveRecord[] {
    return (db.stmt("SELECT * FROM team_moves WHERE thread_id=? AND state NOT IN ('applied','cancelled') ORDER BY created_at,rowid").all(threadId) as unknown as MoveRow[]).map(decode);
  },
  latestForThread(db: Db, threadId: string): TeamMoveRecord | null {
    const row = db
      .stmt(
        "SELECT m.* FROM team_moves m LEFT JOIN team_context_checkpoints c ON c.id=m.applied_context_id WHERE m.thread_id=? AND m.state='applied' ORDER BY c.epoch DESC,m.updated_at DESC,m.rowid DESC LIMIT 1",
      )
      .get(threadId) as unknown as MoveRow | undefined;
    return row ? decode(row) : null;
  },
  create(db: Db, input: CreateTeamMoveInput): TeamMoveRecord {
    const owner = identity.parse(input),
      capture = CapturedInput.parse(input);
    return db.transaction(() => {
      const previous = teamMoves.find(db, owner.threadId, owner.requestKey);
      if (previous) {
        if (JSON.stringify(identity.parse(previous)) !== JSON.stringify(owner) || JSON.stringify(CapturedInput.parse(previous)) !== JSON.stringify(capture))
          throw new Error("This move request already identifies different captured work.");
        return previous;
      }
      if (capture.originMoveId) {
        const origin = teamMoves.latestForThread(db, owner.threadId);
        if (origin?.id !== capture.originMoveId || origin.instanceId !== owner.instanceId || origin.to !== "current")
          throw new Error("A return move needs this instance's latest applied current-workspace origin.");
      } else if (capture.from === "current") {
        const rows = db.stmt("SELECT w.execution_id FROM team_workspaces w JOIN team_executions e ON e.id=w.execution_id WHERE e.instance_id=? AND w.actor_id='lead'").all(owner.instanceId) as {
          execution_id: string;
        }[];
        const owned = rows.some((row) => {
          const workspace = teamWorkspaces.get(db, row.execution_id, "lead");
          return workspace?.path === capture.projectRoot && workspace.state === "ready" && workspace.setupState === "completed" && workspace.preparedTree;
        });
        if (teamMoves.latestForThread(db, owner.threadId) || !owned) throw new Error("An initial local move needs this instance's retained checkout workspace and no previous applied move.");
      }
      const now = Date.now();
      db.stmt("INSERT INTO team_moves(id,thread_id,instance_id,project_id,request_key,request_hash,captured_input,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'pending',?,?)").run(
        owner.id,
        owner.threadId,
        owner.instanceId,
        owner.projectId,
        owner.requestKey,
        owner.requestHash,
        JSON.stringify(capture),
        now,
        now,
      );
      return required(db, owner.id);
    });
  },
  appendPath(db: Db, moveId: string, input: TeamMovePath): TeamMoveRecord {
    const candidate = Candidate.parse(input);
    return db.transaction(() => {
      const record = required(db, moveId);
      if (terminal(record)) throw new Error("This move has already finished.");
      if (candidate.path === record.sourcePath || candidate.path === record.projectRoot || (candidate.kind === "workspace" && (record.to !== "worktree" || record.cancelRequested)))
        throw new Error("Move recovery must use a separate candidate with the correct role.");
      if (db.stmt("SELECT 1 FROM team_moves m,json_each(m.paths) p WHERE json_extract(p.value,'$.path')=?").get(candidate.path))
        throw new Error("This move candidate was already reserved. Recovery requires a new path.");
      db.stmt("UPDATE team_moves SET paths=?,updated_at=? WHERE id=?").run(JSON.stringify([...record.paths, candidate]), updated(record), moveId);
      return required(db, moveId);
    });
  },
  plan(db: Db, moveId: string, input: TeamMovePublication): TeamMoveRecord {
    const publication = Publication.parse(input);
    return db.transaction(() => {
      const record = required(db, moveId);
      if (record.publication) {
        if (JSON.stringify(record.publication) !== JSON.stringify(publication)) throw new Error("A move's verified publication plan is immutable.");
        return record;
      }
      if (terminal(record) || record.cancelRequested) throw new Error("This move cannot admit a publication plan after completion or cancellation.");
      const afterTree = record.to === "current" ? publication.afterTree : record.source.treeSha;
      db.stmt("UPDATE team_moves SET publication=?,after_tree=?,updated_at=? WHERE id=?").run(JSON.stringify(publication), afterTree, updated(record), moveId);
      return required(db, moveId);
    });
  },
  attention(db: Db, moveId: string, error: string): TeamMoveRecord {
    if (!error.trim()) throw new Error("Move recovery needs an error description.");
    const record = required(db, moveId);
    if (terminal(record)) throw new Error("This move has already finished.");
    db.stmt("UPDATE team_moves SET state='attention',error=?,updated_at=? WHERE id=?").run(error, updated(record), moveId);
    return required(db, moveId);
  },
  requestCancel(db: Db, moveId: string): TeamMoveRecord {
    const record = required(db, moveId);
    if (record.state === "applied") throw new Error("An applied move cannot be cancelled.");
    if (record.cancelRequested) return record;
    db.stmt("UPDATE team_moves SET cancel_requested=1,updated_at=? WHERE id=?").run(updated(record), moveId);
    return required(db, moveId);
  },
  cancel(db: Db, moveId: string): TeamMoveRecord {
    return db.transaction(() => {
      const record = required(db, moveId);
      if (record.state === "cancelled") return record;
      if (record.state === "applied" || !record.cancelRequested) throw new Error("A move needs explicit cancellation before it can be released.");
      db.stmt("UPDATE team_moves SET state='cancelled',error=NULL,updated_at=? WHERE id=?").run(updated(record), moveId);
      return required(db, moveId);
    });
  },
  apply(db: Db, moveId: string, input: { path: string; contextCheckpointId: string }): TeamMoveRecord {
    absolute.parse(input.path);
    id.parse(input.contextCheckpointId);
    return db.transaction(() => {
      const record = required(db, moveId);
      if (record.state === "applied") {
        if (record.appliedPath !== input.path || record.appliedContextId !== input.contextCheckpointId) throw new Error("This move was already applied to a different workspace or context.");
        return record;
      }
      if (record.cancelRequested || record.state === "cancelled" || !record.publication) throw new Error("Apply requires a retained publication plan and no cancellation request.");
      if (record.to === "current" ? input.path !== record.projectRoot : record.paths.filter((candidate) => candidate.kind === "workspace").at(-1)?.path !== input.path)
        throw new Error("Apply only the move's intended current workspace or newest workspace candidate.");
      db.stmt("UPDATE team_moves SET state='applied',applied_path=?,applied_context_id=?,error=NULL,updated_at=? WHERE id=?").run(input.path, input.contextCheckpointId, updated(record), moveId);
      return required(db, moveId);
    });
  },
  rejection(db: Db, threadId: string, requestKey: string): TeamMoveRejection | null {
    const row = db.stmt("SELECT * FROM team_move_rejections WHERE thread_id=? AND request_key=?").get(threadId, requestKey) as unknown as RejectionRow | undefined;
    return row ? { threadId: row.thread_id, requestKey: row.request_key, requestHash: row.request_hash, error: row.error, createdAt: row.created_at } : null;
  },
  reject(db: Db, input: Omit<TeamMoveRejection, "createdAt">): TeamMoveRejection {
    id.parse(input.threadId);
    id.max(200).parse(input.requestKey);
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(input.requestHash);
    id.parse(input.error);
    return db.transaction(() => {
      const previous = teamMoves.rejection(db, input.threadId, input.requestKey);
      if (previous) {
        if (previous.requestHash !== input.requestHash || previous.error !== input.error) throw new Error("This move request already identifies a different rejection.");
        return previous;
      }
      const createdAt = Date.now();
      db.stmt("INSERT INTO team_move_rejections(thread_id,request_key,request_hash,error,created_at) VALUES(?,?,?,?,?)").run(
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
