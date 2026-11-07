import type { Brain, MoveRefusal, MoveStep, ThreadMoving } from "@openorc/protocol";
import type { Db } from "./database.js";

interface RelocationBase {
  id: string;
  threadId: string;
  /** The Mac project (coordinator) or the brain's copy of it (brain). */
  projectId: string | null;
  error: string | null;
  /** Where the move stands within its phase, as the coordinator last wrote it; null on the brain. */
  step: MoveStep | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * One host's part in one relocation. The Mac coordinates both directions, since only it can reach both ledgers; the
 * brain's rows record what it did when asked.
 */
export type Relocation =
  /** The Mac moving its thread up. frozen: nothing sent; sending: the brain may have it, only its answer settles it. */
  | (RelocationBase & { role: "coordinator"; direction: "to-cloud"; phase: "frozen" | "sending" | "done" | "abandoned" })
  /** The Mac taking a brain thread. asking: the brain may be frozen; received: imported here, the brain not yet told. */
  | (RelocationBase & { role: "coordinator"; direction: "to-mac"; phase: "asking" | "received" | "done" | "abandoned" })
  /** The brain taking a Mac thread. dropped is a tombstone: a receive for this id that arrives late is refused. */
  | (RelocationBase & { role: "brain"; direction: "to-cloud"; phase: "arrived" | "dropped" })
  /** The brain giving a thread back. leaving: frozen, its package written; stayed: the Mac called it off. */
  | (RelocationBase & { role: "brain"; direction: "to-mac"; phase: "leaving" | "left" | "stayed" });

export type RelocationKind = `${Relocation["role"]}/${Relocation["direction"]}`;
export type CoordinatorRelocation = Extract<Relocation, { role: "coordinator" }>;
type PhaseOf<K extends RelocationKind> = Extract<Relocation, { role: K extends `${infer R}/${string}` ? R : never; direction: K extends `${string}/${infer D}` ? D : never }>["phase"];

/** The phases during which this host refuses every write to the thread. The fence reads this; nothing else decides it. */
export const FROZEN: { [K in RelocationKind]: ReadonlySet<PhaseOf<K>> } = {
  "coordinator/to-cloud": new Set(["frozen", "sending"]),
  // Nothing is local until `received`, and from then the Mac owns it.
  "coordinator/to-mac": new Set(),
  "brain/to-cloud": new Set(),
  "brain/to-mac": new Set(["leaving"]),
};

const OPEN_PHASES = ["frozen", "sending", "asking", "received", "leaving"] as const;

/** What one attempt at a coordinator step came to, before `nextPhase` decides where the row goes. */
export type StepOutcome =
  /** Package uploaded (to-cloud). */
  | { kind: "sent" }
  /** The brain committed the thread (to-cloud). */
  | { kind: "received" }
  /** The brain tombstoned the relocation before taking it (to-cloud, called off). */
  | { kind: "dropped" }
  /** The brain refused and committed nothing. */
  | { kind: "refused"; reason: string }
  /** The Mac committed the thread (to-mac). */
  | { kind: "imported" }
  /** The brain deleted its copy (to-mac). */
  | { kind: "left" }
  /** The brain unfroze its copy (to-mac, called off). */
  | { kind: "stayed" }
  /** Called off on this Mac before anything was sent. */
  | { kind: "kept" }
  /** The brain's machine is gone, and its ledger with it. */
  | { kind: "gone" }
  /** Nothing settled; try again later. */
  | { kind: "unreachable" };

export const GONE_WORDS = "The cloud brain's machine is gone.";

type Next<P extends string> = { [O in StepOutcome["kind"]]?: P };
const TO_CLOUD: { [P in Extract<CoordinatorRelocation, { direction: "to-cloud" }>["phase"]]: Next<Extract<CoordinatorRelocation, { direction: "to-cloud" }>["phase"]> } = {
  frozen: { sent: "sending", refused: "abandoned", gone: "abandoned", kept: "abandoned" },
  // Only the brain's answer leaves it: the brain may have committed, so unreachable and kept stay put.
  sending: { received: "done", refused: "abandoned", dropped: "abandoned", gone: "abandoned" },
  done: {},
  abandoned: {},
};
const TO_MAC: { [P in Extract<CoordinatorRelocation, { direction: "to-mac" }>["phase"]]: Next<Extract<CoordinatorRelocation, { direction: "to-mac" }>["phase"]> } = {
  asking: { imported: "received", refused: "abandoned", stayed: "abandoned", gone: "abandoned" },
  // The Mac owns it now; the brain's copy goes whenever it can be told, or went with its machine.
  received: { left: "done", gone: "done" },
  done: {},
  abandoned: {},
};

/**
 * The coordinator as one pure step: every (direction, phase, outcome) pair has a next phase, an outcome a phase does
 * not expect leaves it where it is, and no pair unfreezes a thread whose target may have committed.
 */
export function nextPhase<R extends CoordinatorRelocation>(row: R, outcome: StepOutcome): { phase: R["phase"]; error: string | null } {
  const table: Record<string, Next<string>> = row.direction === "to-cloud" ? TO_CLOUD : TO_MAC;
  const next = table[row.phase]?.[outcome.kind];
  if (!next) return { phase: row.phase, error: row.error };
  if (outcome.kind === "refused") return { phase: next as R["phase"], error: outcome.reason };
  const error = outcome.kind === "gone" && next === "abandoned" ? GONE_WORDS : null;
  return { phase: next as R["phase"], error };
}

/** Settled for good: nothing more to drive. */
export const settled = (row: CoordinatorRelocation) => row.phase === "done" || row.phase === "abandoned";

interface RelocationRow {
  id: string;
  thread_id: string;
  role: string;
  direction: string;
  phase: string;
  project_id: string | null;
  error: string | null;
  step: string | null;
  created_at: number;
  updated_at: number;
}

const fromRow = (row: RelocationRow): Relocation =>
  ({
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    direction: row.direction,
    phase: row.phase,
    projectId: row.project_id,
    error: row.error,
    step: row.step as MoveStep | null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }) as Relocation;

const openList = OPEN_PHASES.map((phase) => `'${phase}'`).join(", ");

export const relocations = {
  /** Throws when the thread already has an open relocation on this host. */
  open(db: Db, row: Pick<Relocation, "id" | "threadId" | "role" | "direction" | "phase" | "projectId"> & { step?: MoveStep; error?: string }, at = Date.now()): Relocation {
    db.stmt("INSERT INTO thread_relocations (id, thread_id, role, direction, phase, project_id, error, step, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      row.id,
      row.threadId,
      row.role,
      row.direction,
      row.phase,
      row.projectId,
      row.error ?? null,
      row.step ?? null,
      at,
      at,
    );
    return relocations.get(db, row.id) as Relocation;
  },
  get(db: Db, id: string): Relocation | null {
    const row = db.stmt("SELECT * FROM thread_relocations WHERE id = ?").get(id) as RelocationRow | undefined;
    return row ? fromRow(row) : null;
  },
  /** The thread's open relocation on this host, or null. */
  openFor(db: Db, threadId: string): Relocation | null {
    const row = db.stmt(`SELECT * FROM thread_relocations WHERE thread_id = ? AND phase IN (${openList})`).get(threadId) as RelocationRow | undefined;
    return row ? fromRow(row) : null;
  },
  /** Coordinator rows not yet done or abandoned, oldest first, for resuming at start. */
  unsettled(db: Db): CoordinatorRelocation[] {
    const rows = db.stmt("SELECT * FROM thread_relocations WHERE role = 'coordinator' AND phase NOT IN ('done', 'abandoned') ORDER BY created_at").all() as unknown as RelocationRow[];
    return rows.map(fromRow) as CoordinatorRelocation[];
  },
  /** Moves the row on only from the phase the caller saw; false when another step got there first. */
  advance(db: Db, id: string, from: string, to: string, error: string | null = null, at = Date.now()): boolean {
    return db.stmt("UPDATE thread_relocations SET phase = ?, error = ?, updated_at = ? WHERE id = ? AND phase = ?").run(to, error, at, id, from).changes > 0;
  },
  /** Where the move now stands, for its card; the phase is still `advance`'s alone. */
  setStep(db: Db, id: string, step: MoveStep): void {
    db.stmt("UPDATE thread_relocations SET step = ? WHERE id = ?").run(step, id);
  },
  /** What the source still has to clean after letting its copy go, as the caller wrote it; null once clean. */
  setCleanup(db: Db, id: string, cleanup: string | null): void {
    db.stmt("UPDATE thread_relocations SET cleanup = ? WHERE id = ?").run(cleanup, id);
  },
  cleanup(db: Db, id: string): string | null {
    return (db.stmt("SELECT cleanup FROM thread_relocations WHERE id = ?").get(id) as { cleanup: string | null } | undefined)?.cleanup ?? null;
  },
  /** Relocations whose source has cleaning left, for resuming at start. */
  withCleanup(db: Db): string[] {
    return (db.stmt("SELECT id FROM thread_relocations WHERE cleanup IS NOT NULL").all() as { id: string }[]).map((row) => row.id);
  },
  /** The thread's last relocation that settled on this host, newest first. */
  latest(db: Db, threadId: string): Relocation | null {
    const row = db.stmt("SELECT * FROM thread_relocations WHERE thread_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1").get(threadId) as RelocationRow | undefined;
    return row ? fromRow(row) : null;
  },
};

/**
 * Each thread's last move this Mac asked for, when it settled refused with words, as "Didn't move" shows it. The
 * person's own Keep settles with no words, so it is not one. Whether the thread did something since is the reader's to
 * judge, with the thread's own last activity.
 */
export function refusedMoves(db: Db, threadId?: string): { threadId: string; refusal: MoveRefusal }[] {
  const rows = db
    .stmt(
      `SELECT r.thread_id, r.direction, r.phase, r.error, r.updated_at FROM thread_relocations r
       WHERE r.role = 'coordinator' AND (? IS NULL OR r.thread_id = ?) AND NOT EXISTS (
         SELECT 1 FROM thread_relocations later WHERE later.thread_id = r.thread_id AND later.role = 'coordinator'
           AND (later.updated_at > r.updated_at OR (later.updated_at = r.updated_at AND later.rowid > r.rowid)))`,
    )
    .all(threadId ?? null, threadId ?? null) as { thread_id: string; direction: "to-cloud" | "to-mac"; phase: string; error: string | null; updated_at: number }[];
  return rows.flatMap((row) =>
    row.phase === "abandoned" && row.error ? [{ threadId: row.thread_id, refusal: { to: row.direction === "to-cloud" ? "cloud" : "mac", reason: row.error, at: row.updated_at } as const }] : [],
  );
}

/** The thread's last move this Mac asked for, when it was refused with words; null otherwise. */
export const refusedMove = (db: Db, threadId: string): MoveRefusal | null => refusedMoves(db, threadId)[0]?.refusal ?? null;

/** The thread's frozen state on this host, or null: read by every write path. */
export function frozenMoving(db: Db, threadId: string): ThreadMoving | null {
  const row = relocations.openFor(db, threadId);
  if (!row) return null;
  const kind = `${row.role}/${row.direction}` as RelocationKind;
  if (!(FROZEN[kind] as ReadonlySet<string>).has(row.phase)) return null;
  const to: Brain = row.direction === "to-cloud" ? "cloud" : "mac";
  const step: MoveStep | null = row.phase === "sending" ? "sending" : row.step;
  return { to, since: row.createdAt, ...(step ? { step } : {}) };
}

/** A cloud thread this Mac is bringing here but does not hold yet, as its row from the brain should read meanwhile. */
export function incomingMove(db: Db, threadId: string): ThreadMoving | null {
  const row = relocations.openFor(db, threadId);
  if (row?.role !== "coordinator" || row.phase !== "asking") return null;
  return { to: "mac", since: row.createdAt, step: row.step ?? "waking" };
}
