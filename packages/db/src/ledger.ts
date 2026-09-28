import { createHash, randomUUID } from "node:crypto";
import { storeToolImages, type AgentEvent, type ToolImage } from "@openorc/protocol";
import type { Db } from "./database.js";
import { FragmentTracker, factsOf } from "./fragments.js";
import { redactValue } from "./redact.js";
import { messages } from "./search.js";

export interface LedgerOptions {
  /** How long to wait before flushing a partial batch. */
  flushMs?: number;
  maxBatch?: number;
  /** Payloads above this many bytes are stored as artifacts. */
  artifactThresholdBytes?: number;
  previewBytes?: number;
  /** Native provider payloads go here instead of the ledger. The app replays normalized events and never reads these back. */
  native?: (ev: Extract<AgentEvent, { type: "raw" }>) => void;
  /** Stores one image from a tool's output and returns the URL the ledger keeps in its place, or null to keep it inline. */
  storeImage?: (runId: string, image: ToolImage) => string | null;
}

interface EventRow {
  id: number;
  run_id: string;
  seq: number;
  ts: number;
  kind: string;
  payload: string;
}

/**
 * Every agent event lands here. Writes are batched into one transaction per
 * tick, each string in an event is redacted before it touches disk or the
 * search index, and large payloads are split off
 * into the artifacts table so the events table stays fast to scan. Streamed
 * rows are kept only until a later row carries their content, except each
 * item's first, which holds its place.
 */
export class LedgerWriter {
  private queue: AgentEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly seqs = new Map<string, number>();
  private readonly fragments = new FragmentTracker();
  private readonly flushMs: number;
  private readonly maxBatch: number;
  private readonly artifactThreshold: number;
  private readonly previewBytes: number;
  private readonly native: LedgerOptions["native"];
  private readonly storeImage: LedgerOptions["storeImage"];
  eventsWritten = 0;
  artifactsWritten = 0;
  redactions = 0;

  constructor(
    private readonly db: Db,
    options: LedgerOptions = {},
  ) {
    this.flushMs = options.flushMs ?? 50;
    this.maxBatch = options.maxBatch ?? 500;
    this.artifactThreshold = options.artifactThresholdBytes ?? 8 * 1024;
    this.previewBytes = options.previewBytes ?? 1024;
    this.native = options.native;
    this.storeImage = options.storeImage;
  }

  push(ev: AgentEvent): void {
    if (ev.type === "raw" && this.native) {
      this.native(ev);
      return;
    }
    this.queue.push(this.withStoredImages(ev));
    if (this.queue.length >= this.maxBatch) {
      this.flush();
      return;
    }
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.flushMs);
  }

  /** A tool's images go to files before the event is queued, so neither redaction nor the ledger handles their base64. */
  private withStoredImages(ev: AgentEvent): AgentEvent {
    const store = this.storeImage;
    if (ev.type !== "tool.completed" || !store) return ev;
    const output = storeToolImages(ev.output, (image) => store(ev.runId, image));
    return output === ev.output ? ev : { ...ev, output };
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    this.db.transaction(() => {
      for (const ev of batch) this.write(ev);
    });
  }

  close(): void {
    this.flush();
  }

  private nextSeq(runId: string): number {
    let seq = this.seqs.get(runId);
    if (seq === undefined) {
      const row = this.db.stmt("SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE run_id = ?").get(runId) as { m: number };
      seq = row.m;
    }
    seq += 1;
    this.seqs.set(runId, seq);
    return seq;
  }

  private write(ev: AgentEvent): void {
    const { runId, ts, type } = ev;
    const { value: stored, redacted } = redactValue(ev);
    if (redacted) this.redactions += 1;
    const text = JSON.stringify(stored);
    const sha = createHash("sha256").update(text).digest("hex");
    const bytes = Buffer.byteLength(text);
    const toolName = eventToolName(ev);
    const parent = "parentToolCallId" in ev ? ev.parentToolCallId : null;
    const seq = this.nextSeq(runId);
    // What was said is searchable; tool traffic and reasoning stay in the ledger only.
    if (stored.type === "message.completed" && (stored.role === "user" || stored.role === "assistant"))
      messages.index(this.db, { runId, messageId: stored.messageId, role: stored.role, text: stored.text, ts });

    if (bytes > this.artifactThreshold) {
      const preview = { $artifact: true, type, runId, ts, preview: text.slice(0, this.previewBytes) };
      const result = this.db
        .stmt("INSERT INTO events (run_id, seq, ts, kind, tool_name, parent_tool_call_id, payload, payload_sha256, redacted, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(runId, seq, ts, type, toolName, parent, JSON.stringify(preview), sha, redacted ? 1 : 0, bytes);
      const eventId = Number(result.lastInsertRowid);
      this.db.stmt("INSERT INTO artifacts (id, event_id, kind, path, sha256, content, bytes) VALUES (?, ?, 'payload', NULL, ?, ?, ?)").run(randomUUID(), eventId, sha, text, bytes);
      this.artifactsWritten += 1;
    } else {
      this.db
        .stmt("INSERT INTO events (run_id, seq, ts, kind, tool_name, parent_tool_call_id, payload, payload_sha256, redacted, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(runId, seq, ts, type, toolName, parent, text, sha, redacted ? 1 : 0, bytes);
    }
    this.eventsWritten += 1;
    this.settleFragments(ev, seq);
  }

  /** Deletes the streamed rows this one makes redundant; foreign keys take their stored payloads along. */
  private settleFragments(ev: AgentEvent, seq: number): void {
    if (ev.type === "session.completed") this.fragments.endRun(ev.runId);
    const redundant = this.fragments.add(ev.runId, seq, factsOf(ev));
    if (redundant.length) this.db.stmt("DELETE FROM events WHERE run_id = ? AND seq IN (SELECT value FROM json_each(?))").run(ev.runId, JSON.stringify(redundant));
  }
}

export interface ListEventsOptions {
  afterSeq?: number;
  limit?: number;
  includeRaw?: boolean;
  /** Only these kinds, so a reader that needs a few does not parse and inflate the rest. */
  kinds?: readonly AgentEvent["type"][];
  /** When `limit` cuts the run short, keep its newest events instead of its first. They still come back oldest first. */
  newest?: boolean;
}

/** Read events back as AgentEvents, re-inflating artifact payloads. */
export function listEvents(db: Db, runId: string, options: ListEventsOptions = {}): AgentEvent[] {
  const afterSeq = options.afterSeq ?? 0;
  const limit = options.limit ?? 5000;
  const kinds = eventKindFilter(options);
  const rows = db
    .stmt(
      `SELECT e.id, e.run_id, e.seq, e.ts, e.kind, COALESCE(a.content, e.payload) AS payload
       FROM events e LEFT JOIN artifacts a ON a.event_id = e.id AND a.kind = 'payload'
       WHERE e.run_id = ? AND e.seq > ? ${kinds}
       ORDER BY e.seq ${options.newest ? "DESC" : ""} LIMIT ?`,
    )
    .all(runId, afterSeq, ...(options.kinds ?? []), limit) as unknown as EventRow[];
  if (options.newest) rows.reverse();
  const out: AgentEvent[] = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.payload) as AgentEvent);
    } catch {
      out.push({ type: "error", runId: r.run_id, ts: r.ts, message: `ledger row ${r.id} unreadable`, fatal: false });
    }
  }
  return out;
}

export function countEvents(db: Db, runId: string): number {
  const r = db.stmt("SELECT COUNT(*) AS c FROM events WHERE run_id = ?").get(runId) as { c: number };
  return r.c;
}

/** Find a completed tool call without loading a potentially very large transcript. */
export function completedToolCall(db: Db, runId: string, callId: string): Extract<AgentEvent, { type: "tool.completed" }> | undefined {
  const row = db
    .stmt(
      `SELECT COALESCE(a.content, e.payload) AS payload FROM events e
    LEFT JOIN artifacts a ON a.event_id = e.id AND a.kind = 'payload'
    WHERE e.run_id = ? AND e.kind = 'tool.completed'
    AND json_extract(COALESCE(a.content, e.payload), '$.toolCallId') = ? ORDER BY e.seq DESC LIMIT 1`,
    )
    .get(runId, callId) as { payload: string } | undefined;
  if (!row) return undefined;
  const call = JSON.parse(row.payload) as Extract<AgentEvent, { type: "tool.completed" }>;
  const discovered = db
    .stmt(
      `SELECT COALESCE(a.content, e.payload) AS payload FROM events e
    LEFT JOIN artifacts a ON a.event_id = e.id AND a.kind = 'payload'
    WHERE e.run_id = ? AND e.kind = 'tool.updated'
    AND json_extract(COALESCE(a.content, e.payload), '$.toolCallId') = ?
    AND json_type(COALESCE(a.content, e.payload), '$.mcp') = 'object' ORDER BY e.seq DESC LIMIT 1`,
    )
    .get(runId, callId) as { payload: string } | undefined;
  if (discovered) call.mcp = JSON.parse(discovered.payload).mcp;
  return call;
}

function eventToolName(event: AgentEvent): string | null {
  if ("name" in event && typeof event.name === "string") return event.name;
  if ("toolName" in event && typeof event.toolName === "string") return event.toolName;
  return null;
}

function eventKindFilter(options: ListEventsOptions): string {
  if (options.kinds) return `AND e.kind IN (${options.kinds.map(() => "?").join(", ")})`;
  if (options.includeRaw) return "";
  return "AND e.kind <> 'raw'";
}
