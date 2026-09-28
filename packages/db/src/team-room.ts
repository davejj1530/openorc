import { createHash, randomUUID } from "node:crypto";
import { TeamRoomEvent, type TeamRoomCursor, type TeamRoomDelivery } from "@openorc/protocol";
import type { Db } from "./database.js";

interface EventRow {
  instance_id: string;
  seq: number;
  id: string;
  author_kind: TeamRoomEvent["authorKind"];
  author_id: string;
  body: string;
  attachments: string;
  addressees: string;
  reply_to: string | null;
  request_id: string | null;
  execution_id: string | null;
  source: TeamRoomEvent["source"];
  request_key: string | null;
  payload_hash: string;
  created_at: number;
}
interface CursorRow {
  instance_id: string;
  actor_id: string;
  epoch: number;
  delivered_seq: number;
  assessed_seq: number;
  unknown: number;
  updated_at: number;
}
interface DeliveryRow {
  id: string;
  instance_id: string;
  actor_id: string;
  epoch: number;
  from_seq: number;
  to_seq: number;
  operation: TeamRoomDelivery["operation"];
  attempt_id: string | null;
  run_id: string | null;
  state: TeamRoomDelivery["state"];
  error: string | null;
  created_at: number;
  settled_at: number | null;
}

export interface AppendRoomEventInput {
  instanceId: string;
  authorKind: TeamRoomEvent["authorKind"];
  authorId: string;
  body: string;
  attachments?: string[];
  addressees?: string[];
  replyTo?: string | null;
  requestId?: string | null;
  executionId?: string | null;
  source: TeamRoomEvent["source"];
  requestKey?: string | null;
  createdAt?: number;
  id?: string;
}

const decodeEvent = (row: EventRow): TeamRoomEvent =>
  TeamRoomEvent.parse({
    instanceId: row.instance_id,
    seq: row.seq,
    id: row.id,
    authorKind: row.author_kind,
    authorId: row.author_id,
    body: row.body,
    attachments: JSON.parse(row.attachments),
    addressees: JSON.parse(row.addressees),
    replyTo: row.reply_to,
    requestId: row.request_id,
    executionId: row.execution_id,
    source: row.source,
    requestKey: row.request_key,
    createdAt: row.created_at,
  });
const decodeCursor = (row: CursorRow): TeamRoomCursor => ({
  instanceId: row.instance_id,
  actorId: row.actor_id,
  epoch: row.epoch,
  deliveredSeq: row.delivered_seq,
  assessedSeq: row.assessed_seq,
  unknown: row.unknown === 1,
  updatedAt: row.updated_at,
});
const decodeDelivery = (row: DeliveryRow): TeamRoomDelivery => ({
  id: row.id,
  instanceId: row.instance_id,
  actorId: row.actor_id,
  epoch: row.epoch,
  fromSeq: row.from_seq,
  toSeq: row.to_seq,
  operation: row.operation,
  attemptId: row.attempt_id,
  runId: row.run_id,
  state: row.state,
  error: row.error,
  createdAt: row.created_at,
  settledAt: row.settled_at,
});
const payloadHash = (input: AppendRoomEventInput, attachments: string[], addressees: string[]) =>
  createHash("sha256")
    .update(JSON.stringify([input.authorKind, input.authorId, input.body, attachments, addressees, input.replyTo ?? null, input.source]))
    .digest("hex");

/** The team room log: public messages in order, member cursors, and delivery receipts. */
export const teamRoom = {
  /** Appends the next message. A request key makes the append idempotent; the same key with different content is refused. */
  append(db: Db, input: AppendRoomEventInput): TeamRoomEvent {
    if (input.body.length > 100_000) throw new Error("Room messages are limited to 100,000 characters.");
    const attachments = [...new Set(input.attachments ?? [])];
    const addressees = [...new Set(input.addressees ?? [])];
    if (attachments.length > 20) throw new Error("Room messages accept up to 20 attachments.");
    const hash = payloadHash(input, attachments, addressees);
    return db.transaction(() => {
      if (input.requestKey) {
        const existing = db.stmt("SELECT * FROM team_room_events WHERE instance_id=? AND request_key=?").get(input.instanceId, input.requestKey) as unknown as EventRow | undefined;
        if (existing) {
          if (existing.payload_hash !== hash) throw new Error("This message request key already identifies a different room message.");
          return decodeEvent(existing);
        }
      }
      const seq = teamRoom.latestSeq(db, input.instanceId) + 1;
      const id = input.id ?? randomUUID();
      const requestId = roomRequestId(input, id);
      db.stmt(
        "INSERT INTO team_room_events(instance_id,seq,id,author_kind,author_id,body,attachments,addressees,reply_to,request_id,execution_id,source,request_key,payload_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        input.instanceId,
        seq,
        id,
        input.authorKind,
        input.authorId,
        input.body,
        JSON.stringify(attachments),
        JSON.stringify(addressees),
        input.replyTo ?? null,
        requestId,
        input.executionId ?? null,
        input.source,
        input.requestKey ?? null,
        hash,
        input.createdAt ?? Date.now(),
      );
      // The author's own words are already in its session, so pending() skips them; its cursor still moves only over ranges it was handed.
      return teamRoom.get(db, id)!;
    });
  },
  get(db: Db, id: string): TeamRoomEvent | null {
    const row = db.stmt("SELECT * FROM team_room_events WHERE id=?").get(id) as unknown as EventRow | undefined;
    return row ? decodeEvent(row) : null;
  },
  latestSeq(db: Db, instanceId: string): number {
    return (db.stmt("SELECT COALESCE(MAX(seq),0) AS seq FROM team_room_events WHERE instance_id=?").get(instanceId) as { seq: number }).seq;
  },
  /** Messages in order. `afterSeq` and `beforeSeq` bound the range; `limit` caps the page, newest last. */
  list(db: Db, instanceId: string, options: { afterSeq?: number; beforeSeq?: number; limit?: number } = {}): TeamRoomEvent[] {
    const limit = Math.max(1, Math.min(options.limit ?? 500, 500));
    const rows = db
      .stmt("SELECT * FROM team_room_events WHERE instance_id=? AND seq>? AND seq<? ORDER BY seq DESC LIMIT ?")
      .all(instanceId, options.afterSeq ?? 0, options.beforeSeq ?? Number.MAX_SAFE_INTEGER, limit) as unknown as EventRow[];
    return rows.reverse().map(decodeEvent);
  },
  /** Every message said in one execution, in order; unlike `list`, never capped, since a view needs the whole run. */
  forExecution(db: Db, instanceId: string, executionId: string): TeamRoomEvent[] {
    return (db.stmt("SELECT * FROM team_room_events WHERE instance_id=? AND execution_id=? ORDER BY seq").all(instanceId, executionId) as unknown as EventRow[]).map(decodeEvent);
  },
  /** Opening prompts addressed to the lead alone: its instructions in their executions, delivered as the spec there or deliberately abandoned, never room catch-up. */
  leadInstructions(db: Db, instanceId: string): string[] {
    return (db.stmt("SELECT id FROM team_room_events WHERE instance_id=? AND source='prompt' AND addressees='[\"lead\"]'").all(instanceId) as { id: string }[]).map((row) => row.id);
  },
  /** The opening prompts admitted for an execution. */
  openings(db: Db, instanceId: string, executionId: string): string[] {
    return (db.stmt("SELECT id FROM team_room_events WHERE instance_id=? AND execution_id=? AND source='prompt'").all(instanceId, executionId) as { id: string }[]).map((row) => row.id);
  },
  /** The message a request key identifies, if it was ever appended. */
  byRequestKey(db: Db, instanceId: string, requestKey: string): TeamRoomEvent | null {
    const row = db.stmt("SELECT * FROM team_room_events WHERE instance_id=? AND request_key=?").get(instanceId, requestKey) as unknown as EventRow | undefined;
    return row ? decodeEvent(row) : null;
  },
  /** The sequence of the message a request key identifies, if it was ever appended. */
  seqOf(db: Db, instanceId: string, requestKey: string): number | null {
    return teamRoom.byRequestKey(db, instanceId, requestKey)?.seq ?? null;
  },

  /**
   * Copies a room's history up to a point into another instance, for a fork: same authors, words, addressees and
   * sources, new ids, no execution (the fork has none yet), idempotent under one key prefix. Members of the new
   * instance start without cursors, so their first turn bootstraps from the recent slice like any fresh session.
   */
  adopt(db: Db, input: { from: string; to: string; throughSeq: number; requestKeyPrefix: string }): number {
    return db.transaction(() => {
      // list() returns the newest messages of a range, so the history is paged backwards and then copied oldest
      // first: a message's replyTo and requestId can only be remapped once the message they point at has its copy.
      const history: TeamRoomEvent[] = [];
      for (let before = input.throughSeq + 1; ;) {
        const page = teamRoom.list(db, input.from, { beforeSeq: before, limit: 500 });
        if (!page.length) break;
        history.unshift(...page);
        before = page[0]!.seq;
      }
      const ids = new Map<string, string>();
      let copied = 0;
      for (const event of history) {
        const requestKey = `${input.requestKeyPrefix}:${event.seq}`;
        const existing = teamRoom.byRequestKey(db, input.to, requestKey);
        if (existing) {
          ids.set(event.id, existing.id);
          continue;
        }
        const copy = teamRoom.append(db, {
          instanceId: input.to,
          authorKind: event.authorKind,
          authorId: event.authorId,
          body: event.body,
          attachments: event.attachments,
          addressees: event.addressees,
          replyTo: event.replyTo ? (ids.get(event.replyTo) ?? null) : null,
          requestId: event.requestId ? (ids.get(event.requestId) ?? null) : null,
          executionId: null,
          source: event.source,
          requestKey,
          createdAt: event.createdAt,
        });
        ids.set(event.id, copy.id);
        copied += 1;
      }
      return copied;
    });
  },

  /** Removes a conversation's room with it when its owner is deleted for good. */
  purge(db: Db, instanceId: string): void {
    db.transaction(() => {
      db.stmt("DELETE FROM team_room_deliveries WHERE instance_id=?").run(instanceId);
      db.stmt("DELETE FROM team_room_cursors WHERE instance_id=?").run(instanceId);
      db.stmt("DELETE FROM team_room_events WHERE instance_id=?").run(instanceId);
    });
  },

  /** Whether an author posted through team_say since a moment; an ambient turn's public outcome. */
  spokeSince(db: Db, instanceId: string, authorId: string, sinceMs: number): boolean {
    return Boolean(db.stmt("SELECT 1 FROM team_room_events WHERE instance_id=? AND author_id=? AND source='say' AND created_at>=? LIMIT 1").get(instanceId, authorId, sinceMs));
  },

  count(db: Db, instanceId: string): number {
    return (db.stmt("SELECT COUNT(*) AS n FROM team_room_events WHERE instance_id=?").get(instanceId) as { n: number }).n;
  },
  cursor(db: Db, instanceId: string, actorId: string): TeamRoomCursor {
    const row = db.stmt("SELECT * FROM team_room_cursors WHERE instance_id=? AND actor_id=?").get(instanceId, actorId) as unknown as CursorRow | undefined;
    return row ? decodeCursor(row) : { instanceId, actorId, epoch: 0, deliveredSeq: 0, assessedSeq: 0, unknown: false, updatedAt: 0 };
  },
  cursors(db: Db, instanceId: string): TeamRoomCursor[] {
    return (db.stmt("SELECT * FROM team_room_cursors WHERE instance_id=? ORDER BY actor_id").all(instanceId) as unknown as CursorRow[]).map(decodeCursor);
  },
  /** Confirmed, assessed delivery ranges only; migration cursors are not read receipts. */
  readers(db: Db, instanceId: string, executionId: string): Map<string, string[]> {
    const rows = db
      .stmt(
        `SELECT DISTINCT e.id, d.actor_id FROM team_room_events e
      JOIN team_room_deliveries d ON d.instance_id=e.instance_id AND e.seq BETWEEN d.from_seq AND d.to_seq
      LEFT JOIN team_room_cursors c ON c.instance_id=d.instance_id AND c.actor_id=d.actor_id
      WHERE e.instance_id=? AND e.execution_id=? AND d.state='confirmed'
        AND (d.operation='turn' OR (c.unknown=0 AND c.assessed_seq>=e.seq))`,
      )
      .all(instanceId, executionId) as { id: string; actor_id: string }[];
    const result = new Map<string, string[]>();
    for (const row of rows) result.set(row.id, [...(result.get(row.id) ?? []), row.actor_id]);
    return result;
  },
  /** Places a cursor explicitly: migration of sessions that predate the room, or a fresh context that starts from a known point. */
  setCursor(db: Db, input: { instanceId: string; actorId: string; epoch: number; seq: number; unknown?: boolean }): TeamRoomCursor {
    db.stmt(
      "INSERT INTO team_room_cursors(instance_id,actor_id,epoch,delivered_seq,assessed_seq,unknown,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(instance_id,actor_id) DO UPDATE SET epoch=excluded.epoch, delivered_seq=excluded.delivered_seq, assessed_seq=excluded.assessed_seq, unknown=excluded.unknown, updated_at=excluded.updated_at",
    ).run(input.instanceId, input.actorId, input.epoch, input.seq, input.seq, input.unknown ? 1 : 0, Date.now());
    return teamRoom.cursor(db, input.instanceId, input.actorId);
  },
  /** Moves a cursor forward over a contiguous confirmed range; it never moves back. */
  advance(db: Db, instanceId: string, actorId: string, throughSeq: number, options: { assessed?: boolean; epoch?: number } = {}): TeamRoomCursor {
    const current = teamRoom.cursor(db, instanceId, actorId);
    const epoch = options.epoch ?? current.epoch;
    const delivered = Math.max(current.deliveredSeq, throughSeq);
    const assessed = options.assessed ? Math.max(current.assessedSeq, throughSeq) : Math.min(current.assessedSeq, delivered);
    db.stmt(
      "INSERT INTO team_room_cursors(instance_id,actor_id,epoch,delivered_seq,assessed_seq,unknown,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(instance_id,actor_id) DO UPDATE SET epoch=excluded.epoch, delivered_seq=excluded.delivered_seq, assessed_seq=excluded.assessed_seq, unknown=0, updated_at=excluded.updated_at",
    ).run(instanceId, actorId, epoch, delivered, assessed, 0, Date.now());
    return teamRoom.cursor(db, instanceId, actorId);
  },
  /** Messages a member's session has not been handed yet, in order. Its own messages never count. */
  pending(db: Db, instanceId: string, actorId: string, limit = 500): TeamRoomEvent[] {
    const cursor = teamRoom.cursor(db, instanceId, actorId);
    const rows = db
      .stmt("SELECT * FROM team_room_events WHERE instance_id=? AND seq>? AND author_id<>? ORDER BY seq LIMIT ?")
      .all(instanceId, cursor.deliveredSeq, actorId, limit) as unknown as EventRow[];
    return rows.map(decodeEvent);
  },
  reserveDelivery(
    db: Db,
    input: {
      instanceId: string;
      actorId: string;
      epoch: number;
      fromSeq: number;
      toSeq: number;
      operation: TeamRoomDelivery["operation"];
      attemptId?: string | null;
      runId?: string | null;
      state?: "queued" | "submitted";
    },
  ): TeamRoomDelivery {
    const id = randomUUID();
    db.stmt(
      "INSERT INTO team_room_deliveries(id,instance_id,actor_id,epoch,from_seq,to_seq,operation,attempt_id,run_id,state,error,created_at,settled_at) VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,NULL)",
    ).run(id, input.instanceId, input.actorId, input.epoch, input.fromSeq, input.toSeq, input.operation, input.attemptId ?? null, input.runId ?? null, input.state ?? "queued", Date.now());
    return teamRoom.delivery(db, id)!;
  },
  delivery(db: Db, id: string): TeamRoomDelivery | null {
    const row = db.stmt("SELECT * FROM team_room_deliveries WHERE id=?").get(id) as unknown as DeliveryRow | undefined;
    return row ? decodeDelivery(row) : null;
  },
  deliveries(db: Db, instanceId: string, options: { actorId?: string; attemptId?: string } = {}): TeamRoomDelivery[] {
    const rows = db
      .stmt("SELECT * FROM team_room_deliveries WHERE instance_id=? AND (? IS NULL OR actor_id=?) AND (? IS NULL OR attempt_id=?) ORDER BY created_at, rowid")
      .all(instanceId, options.actorId ?? null, options.actorId ?? null, options.attemptId ?? null, options.attemptId ?? null) as unknown as DeliveryRow[];
    return rows.map(decodeDelivery);
  },
  submitted(db: Db, id: string, runId?: string | null): TeamRoomDelivery {
    db.stmt("UPDATE team_room_deliveries SET state='submitted', run_id=COALESCE(?,run_id) WHERE id=? AND state='queued'").run(runId ?? null, id);
    return teamRoom.delivery(db, id)!;
  },
  /** A confirmed delivery advances the member's cursor; the other outcomes leave it where it was, so the range is handed over again. */
  settleDelivery(db: Db, id: string, state: "confirmed" | "uncertain" | "cancelled", options: { error?: string | null; assessed?: boolean } = {}): TeamRoomDelivery {
    return db.transaction(() => {
      const delivery = teamRoom.delivery(db, id);
      if (!delivery) throw new Error("Room delivery not found.");
      if (delivery.state === state) return delivery;
      if (["confirmed", "uncertain", "cancelled"].includes(delivery.state)) throw new Error(`Room delivery ${id} is already ${delivery.state}.`);
      db.stmt("UPDATE team_room_deliveries SET state=?, error=?, settled_at=? WHERE id=?").run(state, options.error ?? null, Math.max(Date.now(), delivery.createdAt), id);
      if (state === "confirmed") teamRoom.advance(db, delivery.instanceId, delivery.actorId, delivery.toSeq, { assessed: options.assessed ?? false, epoch: delivery.epoch });
      return teamRoom.delivery(db, id)!;
    });
  },
};

function roomRequestId(input: Pick<AppendRoomEventInput, "requestId" | "authorKind">, id: string): string | null {
  if (input.requestId !== undefined) return input.requestId;
  return input.authorKind === "user" ? id : null;
}
