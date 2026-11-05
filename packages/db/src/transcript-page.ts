import { toolDigest, type AgentEvent } from "@openorc/protocol";
import type { Db } from "./database.js";

/** Tool results whose stored event is larger than this stay out of a page; the row loads its output when opened. */
export const OMIT_OUTPUT_CHARS = 4096;
/** Task tools stay whole: their rows read the task id from the output. */
const KEEPS_OUTPUT = /task_(?:create|start)$/;

const leavesOutputOut = (event: Extract<AgentEvent, { type: "tool.completed" }>) => !KEEPS_OUTPUT.test(event.name) && JSON.stringify(event).length > OMIT_OUTPUT_CHARS;

/** The page's rule for one event already in hand, as a live view applies it to a redacted event. */
export function pagedEvent(event: AgentEvent): AgentEvent {
  if (event.type !== "tool.completed" || !leavesOutputOut(event)) return event;
  // Undefined leaves the key out of the JSON, as the page's json_remove does.
  return { ...event, output: undefined, outputOmitted: true };
}

/** A result that pages will leave out keeps its digest, so a page still says what it came to. Stored once, before the ledger. */
export function digestedEvent(event: AgentEvent): AgentEvent {
  if (event.type !== "tool.completed" || event.digest || !leavesOutputOut(event)) return event;
  const digest = toolDigest(event.output);
  return digest ? { ...event, digest } : event;
}

export interface TranscriptPage {
  events: AgentEvent[];
  /** The turn the events start at; 0 when they cover the whole run. */
  fromTurn: number;
}

/**
 * A run's events from one turn onward, so a conversation can replay the part the reader sees. Turns are counted
 * the way the transcript counts them, by the turn.completed events before: `turns` asks for the newest few,
 * `fromTurn` for everything from that turn on. A large tool result is left out and marked `outputOmitted`; SQLite
 * drops it, so it is never parsed here.
 */
export function transcriptPage(db: Db, runId: string, request: { fromTurn?: number; turns?: number }): TranscriptPage {
  const ends = (db.stmt("SELECT seq FROM events WHERE run_id = ? AND kind = 'turn.completed' ORDER BY seq").all(runId) as Array<{ seq: number }>).map((row) => row.seq);
  const wanted = request.fromTurn ?? (request.turns !== undefined ? ends.length - request.turns : 0);
  const fromTurn = Math.min(ends.length, Math.max(0, wanted));
  // Large rows keep their JSON in artifacts. Task tools stay whole: their rows read the task id from the output.
  const body = "COALESCE(a.content, e.payload)";
  const rows = db
    .stmt(
      `SELECT e.id, e.ts,
         CASE WHEN e.kind = 'tool.completed' AND length(${body}) > ${OMIT_OUTPUT_CHARS} AND json_valid(${body})
                AND COALESCE(e.tool_name, '') NOT GLOB '*task_create' AND COALESCE(e.tool_name, '') NOT GLOB '*task_start'
              THEN json_set(json_remove(${body}, '$.output'), '$.outputOmitted', json('true'))
              ELSE ${body} END AS payload
       FROM events e LEFT JOIN artifacts a ON a.event_id = e.id AND a.kind = 'payload'
       WHERE e.run_id = ? AND e.seq > ? AND e.kind <> 'raw'
       ORDER BY e.seq`,
    )
    .all(runId, fromTurn > 0 ? ends[fromTurn - 1]! : 0) as Array<{ id: number; ts: number; payload: string }>;
  return { events: rows.map((row) => readRow(runId, row)), fromTurn };
}

/** One message's final text as the ledger keeps it, or null while the run has not completed it. */
export function messageText(db: Db, runId: string, messageId: string): string | null {
  const body = "COALESCE(a.content, e.payload)";
  const row = db
    .stmt(
      `SELECT ${body} AS payload FROM events e LEFT JOIN artifacts a ON a.event_id = e.id AND a.kind = 'payload'
       WHERE e.run_id = ? AND e.kind = 'message.completed' AND json_valid(${body}) AND json_extract(${body}, '$.messageId') = ?
       ORDER BY e.seq DESC LIMIT 1`,
    )
    .get(runId, messageId) as { payload: string } | undefined;
  if (!row) return null;
  const event = readRow(runId, { id: 0, ts: 0, payload: row.payload });
  return event.type === "message.completed" ? event.text : null;
}

/** A row that no longer parses reads as a non-fatal error, as listEvents does, rather than failing the page. */
function readRow(runId: string, row: { id: number; ts: number; payload: string }): AgentEvent {
  try {
    return JSON.parse(row.payload) as AgentEvent;
  } catch {
    return { type: "error", runId, ts: row.ts, message: `ledger row ${row.id} unreadable`, fatal: false };
  }
}
