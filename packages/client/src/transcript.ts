import type { ActivityRecovery, ActivityStatus, AgentEvent, AgentEventType, McpToolSource, ToolDigest } from "@openorc/protocol";
import { replaceSubagentCompletionReply, subagentBlock, subagentCompletionReply, type SubagentCard } from "./transcript-subagents.js";
import { recordHostedContext } from "./hosted-run-facts.js";

/**
 * Transcript projection. Events fold into blocks. A change replaces only the blocks it touches and the arrays that
 * hold them, and each run is its own snapshot, so a component showing one run ignores every other run's stream.
 */
const ACTIVITY_BLOCK = "activity-";

/** An activity's block id in a run transcript, and back: the agent's own activity id is what the Mac knows it by. */
export const activityBlockId = (activityId: string) => `${ACTIVITY_BLOCK}${activityId}`;
export const activityIdOf = (blockId: string) => (blockId.startsWith(ACTIVITY_BLOCK) ? blockId.slice(ACTIVITY_BLOCK.length) : blockId);

/** `seq`: the place in a cloud thread's log of the event that made the block, where notes take theirs. */
export type Block = { at?: number; turnKey?: string; runId?: string; seq?: number } & (
  | {
      id: string;
      kind: "message";
      role: "assistant" | "user" | "system";
      text: string;
      streaming: boolean;
      at?: number;
      attachments?: string[];
      runId?: string;
      /** Sent from this window and shown at once; the core has not recorded it yet. */
      pending?: boolean;
      /**
       * Said while a turn ran. A notice, such as who stopped it, reads under that turn's head, never as its opening; a
       * person's message steers that turn.
       */
      inTurn?: boolean;
    }
  | { id: string; kind: "thinking"; text: string; startedAt: number; endedAt: number | null; explicit?: boolean; status?: ActivityStatus }
  | {
      id: string;
      kind: "tool";
      name: string;
      input: unknown;
      output?: unknown;
      /** The output was left out of the loaded page; the row fetches it when opened. */
      outputOmitted?: boolean;
      isError?: boolean;
      done: boolean;
      status?: ActivityStatus;
      progress?: string;
      /** What a large output came to, when the page left the output out. */
      digest?: ToolDigest;
      mcp?: McpToolSource;
      subagent?: SubagentCard;
    }
  | {
      id: string;
      kind: "activity";
      label: string;
      status: ActivityStatus;
      text: string;
      detail?: unknown;
      activityKind?: "image_generation";
      imagePath?: string;
      recovery?: ActivityRecovery;
    }
  | {
      id: string;
      kind: "approval";
      approvalId: string;
      approvalKind: string;
      toolName?: string;
      input: unknown;
      reason?: string;
      /** Only Allow applies; nothing would keep allowing it for the rest of the run. */
      onceOnly?: boolean;
      decision?: string;
      answers?: Record<string, string[]>;
      /** Only an answer closes it: it outlives its turn and its process, as an OpenOrc Cloud thread's asks do. */
      durable?: boolean;
    }
  | {
      id: string;
      kind: "status";
      text: string;
      tone: "muted" | "ok" | "bad";
      notice?: boolean;
      /** The way on from a limit the thread could not go past: the agent's own, carried to the server's line that says so. */
      recovery?: ActivityRecovery;
      boundary?: "turn" | "session";
      durationMs?: number;
      /**
       * `parked`: a cloud turn that ended waiting on its ask, whose answer starts the next turn. `limited`: a cloud turn
       * that stopped at its sender's usage limit, which the server's own line tells of.
       */
      outcome?: "success" | "error" | "cancelled" | "no_updates" | "parked" | "limited";
    }
);

export interface RunTranscript {
  runId: string;
  context?: { used: number; window: number | null };
  blocks: Block[];
  blockIndex: Map<string, number>;
  live: boolean;
  /** A turn is under way: the agent took a prompt and no result has ended it. Never true once the session ended. */
  turnOpen: boolean;
  hydrated: boolean;
  /** The first turn loaded from the ledger. 0 once the whole run is here, which a run seen from its start always is. */
  fromTurn: number;
  eventCount: number;
  /** Timestamp of the event being projected, including history replay. */
  eventAt?: number;
  /** The place of the event being projected in a cloud thread's log; none for this Mac's own. */
  eventSeq?: number;
  eventIds?: Set<string>;
  /** Turns finished before the newest block, counted from the run's start even when earlier turns are not loaded. */
  turnsCompleted: number;
  /** Late file records still belong before this hosted child's closing boundary. Cleared when it starts again. */
  subagentCompletion?: { turn: number; boundaryId: string; resultId?: string };
  /** Which turn of this process each block belongs to. A warm session's transcript holds several turns. */
  turnOf: Map<string, number>;
  /** The way on from the usage limit the last turn stopped at, for the server's line if it says the thread held there. */
  limitRecovery?: ActivityRecovery;
  pendingApprovals: number;
  /** The agent's stderr. Kept off the transcript; the ledger has it all. */
  stderr: string[];
}

export function emptyRun(runId: string): RunTranscript {
  return { runId, blocks: [], blockIndex: new Map(), live: false, turnOpen: false, hydrated: false, fromTurn: 0, eventCount: 0, turnsCompleted: 0, turnOf: new Map(), pendingApprovals: 0, stderr: [] };
}

function upsert(run: RunTranscript, block: Block): void {
  const i = run.blockIndex.get(block.id);
  const previous = i === undefined ? undefined : run.blocks[i];
  const turn = run.subagentCompletion?.turn ?? run.turnsCompleted;
  const seq = previous?.seq ?? block.seq ?? run.eventSeq;
  block = { ...block, runId: run.runId, at: previous?.at ?? block.at ?? run.eventAt, turnKey: previous?.turnKey ?? `${run.runId}:${turn}`, ...(seq !== undefined && { seq }) };
  if (i === undefined) {
    run.turnOf.set(block.id, turn);
    const boundary = run.subagentCompletion && block.kind !== "status" ? run.blockIndex.get(run.subagentCompletion.boundaryId) : undefined;
    const index = boundary ?? run.blocks.length;
    run.blocks.splice(index, 0, block);
    for (let j = index; j < run.blocks.length; j++) run.blockIndex.set(run.blocks[j]!.id, j);
  } else {
    run.blocks[i] = block;
  }
}

function get<K extends Block["kind"]>(run: RunTranscript, id: string, kind: K): Extract<Block, { kind: K }> | undefined {
  const i = run.blockIndex.get(id);
  const b = i === undefined ? undefined : run.blocks[i];
  return b && b.kind === kind ? (b as Extract<Block, { kind: K }>) : undefined;
}

/** A thinking block ends when anything else arrives; that is how long the agent thought. */
function closeThinking(run: RunTranscript, ts: number): void {
  const last = run.blocks[run.blocks.length - 1];
  if (last && last.kind === "thinking" && last.endedAt === null && !last.explicit) upsert(run, { ...last, endedAt: ts });
}

/** Terminal boundaries also cover items whose provider never sent completion. A durable ask is not one of them. */
function closeActive(run: RunTranscript, ts: number, status: ActivityStatus): void {
  let waiting = 0;
  for (const block of run.blocks) {
    if (block.kind === "thinking" && block.endedAt === null) upsert(run, { ...block, endedAt: ts, status });
    if (block.kind === "tool" && !block.done && !block.subagent) upsert(run, { ...block, done: true, status, isError: status === "error" });
    if (block.kind === "activity" && block.status === "running") upsert(run, { ...block, status });
    if (block.kind === "message" && block.streaming) upsert(run, { ...block, streaming: false });
    if (block.kind === "approval" && !block.decision) {
      if (block.durable) waiting += 1;
      else upsert(run, { ...block, decision: "expired" });
    }
  }
  run.pendingApprovals = waiting;
}

/**
 * A turn that stopped at its usage limit loses the agent's own word of it, the failed step with its way to usage: the
 * server's line says it once, the move to another account or, when the thread held there, that it did, with the way on.
 */
function dropLimitRecovery(run: RunTranscript): void {
  const turn = run.turnsCompleted;
  const gone = run.blocks.filter((block): block is Extract<Block, { kind: "activity" }> => block.kind === "activity" && block.recovery?.kind === "usage" && run.turnOf.get(block.id) === turn);
  if (!gone.length) return;
  run.limitRecovery = gone[0]!.recovery;
  const ids = new Set(gone.map((block) => block.id));
  run.blocks = run.blocks.filter((block) => !ids.has(block.id));
  run.blockIndex = new Map(run.blocks.map((block, index) => [block.id, index]));
  for (const block of gone) run.turnOf.delete(block.id);
}

/** The process is gone, and any turn with it. */
function endSession(run: RunTranscript): void {
  run.live = false;
  run.turnOpen = false;
}

function completionOutcome(status: Extract<AgentEvent, { type: "turn.completed" | "session.completed" }>["status"]): "success" | "cancelled" | "error" {
  if (status === "success") return "success";
  if (status === "cancelled") return "cancelled";
  return "error";
}

function sessionCloseStatus(status: Extract<AgentEvent, { type: "session.completed" }>["status"]): ActivityStatus {
  if (status === "error") return "error";
  if (status === "cancelled") return "cancelled";
  return "disconnected";
}

function approvalBlock(ev: Extract<AgentEvent, { type: "approval.requested" }>): Block {
  return {
    id: `approval-${ev.approvalId}`,
    kind: "approval",
    approvalId: ev.approvalId,
    approvalKind: ev.kind,
    input: ev.input,
    ...(ev.toolName ? { toolName: ev.toolName } : {}),
    ...(ev.reason ? { reason: ev.reason } : {}),
    ...(ev.onceOnly ? { onceOnly: true } : {}),
    ...(ev.durable ? { durable: true } : {}),
  };
}

type Handler<T extends AgentEventType> = (run: RunTranscript, ev: Extract<AgentEvent, { type: T }>) => void;
const ignore = () => {};

/**
 * A notice said while the run's turn is open belongs to that turn, after its head. A person's message steers a turn the
 * agent is working in: its reply streams, or the open turn already holds its work.
 */
function inTurn(run: RunTranscript, role: string, existing: { inTurn?: boolean } | undefined): { inTurn?: true } {
  if (existing?.inTurn) return { inTurn: true };
  if (role === "system") return run.turnOpen ? { inTurn: true } : {};
  return role === "user" && steers(run) ? { inTurn: true } : {};
}
function steers(run: RunTranscript): boolean {
  const open = `${run.runId}:${run.turnsCompleted}`;
  return run.blocks.some(
    (block) =>
      (block.kind === "message" && block.role === "assistant" && block.streaming) ||
      (run.turnOpen && block.turnKey === open && block.kind !== "status" && !(block.kind === "message" && block.role !== "assistant")),
  );
}

/** What each event does to a run. Total over event types, so a new one does not compile until it has a decision. */
const handlers: { [T in AgentEventType]: Handler<T> } = {
  "session.started": (run, ev) => {
    run.live = true;
    upsert(run, { id: "status-start", kind: "status", tone: "muted", text: `${ev.agent} session started${ev.model ? ` with ${ev.model}` : ""}` });
  },
  "message.delta": (run, ev) => {
    const existing = get(run, ev.messageId, "message");
    upsert(run, { id: ev.messageId, kind: "message", role: ev.role, text: (existing?.text ?? "") + ev.text, streaming: true, at: existing?.at ?? ev.ts, ...inTurn(run, ev.role, existing) });
  },
  "message.completed": (run, ev) => {
    if (ev.role === "assistant" && ev.text.trim()) replaceSubagentCompletionReply(run);
    const existing = get(run, ev.messageId, "message");
    upsert(run, {
      id: ev.messageId,
      kind: "message",
      role: ev.role,
      text: ev.text,
      streaming: false,
      at: existing?.at ?? ev.ts,
      ...(ev.attachments ? { attachments: ev.attachments } : {}),
      ...inTurn(run, ev.role, existing),
    });
  },
  "thinking.started": (run, ev) => {
    const id = `think-${ev.messageId}`;
    const existing = get(run, id, "thinking");
    if (!existing) upsert(run, { id, kind: "thinking", text: "", startedAt: ev.ts, endedAt: null, explicit: true });
  },
  "thinking.completed": (run, ev) => {
    const id = `think-${ev.messageId}`;
    const existing = get(run, id, "thinking");
    upsert(run, { id, kind: "thinking", text: ev.text || existing?.text || "", startedAt: existing?.startedAt ?? ev.ts, endedAt: ev.ts, explicit: true, status: "success" });
  },
  "activity.updated": (run, ev) => {
    const id = activityBlockId(ev.activityId);
    const existing = get(run, id, "activity");
    upsert(run, {
      ...existing,
      id,
      kind: "activity",
      label: ev.label,
      status: ev.status,
      text: ev.text ?? existing?.text ?? "",
      ...(ev.detail !== undefined ? { detail: ev.detail } : {}),
      ...(ev.activityKind ? { activityKind: ev.activityKind } : {}),
      ...(ev.recovery ? { recovery: ev.recovery } : {}),
      ...(ev.imagePath ? { imagePath: ev.imagePath } : {}),
    });
  },
  "activity.delta": (run, ev) => {
    const id = activityBlockId(ev.activityId);
    const existing = get(run, id, "activity");
    upsert(run, { ...existing, id, kind: "activity", label: ev.label, status: existing?.status ?? "running", text: (existing?.text ?? "") + ev.text });
  },
  "thinking.delta": (run, ev) => {
    const id = `think-${ev.messageId}`;
    const existing = get(run, id, "thinking");
    upsert(run, { ...existing, id, kind: "thinking", text: (existing?.text ?? "") + ev.text, startedAt: existing?.startedAt ?? ev.ts, endedAt: existing?.endedAt ?? null });
  },
  "tool.started": (run, ev) => {
    if (get(run, ev.toolCallId, "tool")?.subagent) return;
    upsert(run, { id: ev.toolCallId, kind: "tool", name: ev.name, input: ev.input, done: false, ...(ev.mcp ? { mcp: ev.mcp } : {}) });
  },
  "tool.output.delta": (run, ev) => {
    const existing = get(run, ev.toolCallId, "tool");
    if (existing) upsert(run, { ...existing, output: (typeof existing.output === "string" ? existing.output : "") + ev.text });
  },
  "tool.updated": (run, ev) => {
    const existing = get(run, ev.toolCallId, "tool");
    if (existing)
      upsert(run, { ...existing, ...(ev.input !== undefined ? { input: ev.input } : {}), ...(ev.progress !== undefined ? { progress: ev.progress } : {}), ...(ev.mcp ? { mcp: ev.mcp } : {}) });
  },
  "tool.completed": (run, ev) => {
    const existing = get(run, ev.toolCallId, "tool");
    if (existing?.subagent) return;
    upsert(run, {
      id: ev.toolCallId,
      kind: "tool",
      name: ev.name,
      input: ev.input ?? existing?.input,
      // An output left out of the page is read when the row opens, never pieced together from a kept fragment.
      ...(ev.outputOmitted ? { outputOmitted: true } : { output: ev.output ?? existing?.output }),
      ...(ev.digest ? { digest: ev.digest } : {}),
      ...((ev.mcp ?? existing?.mcp) ? { mcp: ev.mcp ?? existing?.mcp } : {}),
      isError: ev.isError,
      done: true,
      status: ev.status ?? (ev.isError ? "error" : "success"),
      ...(existing?.progress ? { progress: existing.progress } : {}),
    });
  },
  "approval.requested": (run, ev) => {
    run.pendingApprovals += 1;
    upsert(run, approvalBlock(ev));
  },
  "approval.resolved": (run, ev) => {
    const existing = get(run, `approval-${ev.approvalId}`, "approval");
    if (existing && !existing.decision) run.pendingApprovals = Math.max(0, run.pendingApprovals - 1);
    if (existing) upsert(run, { ...existing, decision: ev.decision, ...(ev.answers ? { answers: ev.answers } : {}) });
  },
  "turn.started": (run) => {
    run.turnOpen = true;
    delete run.subagentCompletion;
    delete run.limitRecovery;
  },
  "turn.completed": (run, ev) => {
    run.turnOpen = false;
    closeActive(run, ev.ts, ev.observationEnded ? "disconnected" : completionOutcome(ev.status));
    const reply = subagentCompletionReply(run, ev);
    if (reply) upsert(run, reply);
    upsert(run, {
      id: run.subagentCompletion?.boundaryId ?? `turn-${ev.turnId}`,
      boundary: "turn",
      durationMs: ev.durationMs,
      outcome: ev.observationEnded ? "no_updates" : completionOutcome(ev.status),
      kind: "status",
      tone: ev.status === "success" ? "ok" : "bad",
      text: `turn ${ev.status === "success" ? "finished" : ev.status} in ${(ev.durationMs / 1000).toFixed(1)}s${ev.usage ? `, ${ev.usage.inputTokens.toLocaleString()} in / ${ev.usage.outputTokens.toLocaleString()} out` : ""}`,
      ...(ev.observationEnded ? { tone: "muted", text: "Updates stopped" } : {}),
      // Parked on its ask, it ended without failing: the ask stays open, and the turn its answer starts is the next one.
      ...(ev.parked ? { outcome: "parked", tone: "muted", text: `turn parked in ${(ev.durationMs / 1000).toFixed(1)}s` } : {}),
      // Stopped at a usage limit, it did not fail either: the server's line after it says whether the thread went on.
      ...(ev.limited ? { outcome: "limited", tone: "muted", text: `turn stopped at a usage limit in ${(ev.durationMs / 1000).toFixed(1)}s` } : {}),
    });
    if (ev.limited) dropLimitRecovery(run);
    run.turnsCompleted += 1;
  },
  "session.completed": (run, ev) => {
    closeActive(run, ev.ts, sessionCloseStatus(ev.status));
    endSession(run);
    upsert(run, {
      id: "status-end",
      boundary: "session",
      outcome: completionOutcome(ev.status),
      kind: "status",
      tone: ev.status === "success" ? "muted" : "bad",
      text: `session ${ev.status === "success" ? "closed" : ev.status}`,
    });
  },
  error: (run, ev) => {
    if (ev.fatal) {
      closeActive(run, ev.ts, "error");
      endSession(run);
      const recovery = run.limitRecovery;
      upsert(run, { id: `err-${ev.ts}-${run.blocks.length}`, kind: "status", boundary: "session", outcome: "error", tone: "bad", text: ev.message, ...(recovery && { recovery }) });
    } else {
      run.stderr.push(ev.message);
      if (run.stderr.length > 500) run.stderr.shift();
    }
  },
  "file.changed": ignore,
  "usage.updated": recordHostedContext,
  "background.updated": ignore,
  "subagent.started": (run, ev) => {
    const block = subagentBlock(run, ev);
    if (block) upsert(run, block);
  },
  "subagent.updated": (run, ev) => {
    const block = subagentBlock(run, ev);
    if (block) upsert(run, block);
    if (ev.notice) upsert(run, { id: `subagent-notice:${ev.subagentId}:${ev.ts}`, kind: "status", tone: "muted", notice: true, text: ev.notice });
  },
  raw: ignore,
  // Plans load through threads.plans, and how full the context is comes with the thread summary.
  "plan.updated": ignore,
  "context.updated": recordHostedContext,
};

/**
 * Event ids a run remembers to drop events it already has. Repeats only come from a page overlapping the frames
 * that arrived while it loaded, or a frame sent again, so the newest few thousand ids are enough.
 */
const REMEMBERED_EVENT_IDS = 4096;

/** False for an event the run already has. */
function admit(run: RunTranscript, ev: AgentEvent): boolean {
  if (!ev.eventId) return true;
  run.eventIds ??= new Set();
  if (run.eventIds.has(ev.eventId)) return false;
  run.eventIds.add(ev.eventId);
  if (run.eventIds.size > REMEMBERED_EVENT_IDS) run.eventIds.delete(run.eventIds.values().next().value!);
  return true;
}

/** A cloud thread's event names its place in the thread's log: `<thread>.<seq>`. */
const HOSTED_EVENT = /^[^.]+\.(\d+)$/;

function project(run: RunTranscript, ev: AgentEvent): void {
  run.eventAt = ev.ts;
  const hosted = ev.eventId ? HOSTED_EVENT.exec(ev.eventId) : null;
  run.eventSeq = hosted ? Number(hosted[1]) : undefined;
  if (!ev.type.startsWith("thinking.") && ev.type !== "raw" && ev.type !== "usage.updated" && ev.type !== "background.updated") closeThinking(run, ev.ts);
  (handlers[ev.type] as Handler<AgentEventType>)(run, ev);
}

type Delta = Extract<AgentEvent, { type: "message.delta" | "thinking.delta" | "tool.output.delta" | "activity.delta" }>;

/** The item a delta grows. Deltas only fold while everything the projection reads from them but text agrees. */
const deltaItem: { [T in Delta["type"]]: (ev: Extract<Delta, { type: T }>) => string } = {
  "message.delta": (ev) => `${ev.messageId}\n${ev.role}`,
  "thinking.delta": (ev) => ev.messageId,
  "tool.output.delta": (ev) => ev.toolCallId,
  "activity.delta": (ev) => `${ev.activityId}\n${ev.label}`,
};

function isDelta(ev: AgentEvent): ev is Delta {
  return Object.hasOwn(deltaItem, ev.type);
}

function itemOf(ev: Delta): string {
  return `${ev.type}\n${(deltaItem[ev.type] as (ev: Delta) => string)(ev)}`;
}

/**
 * Applies events in order, folding consecutive deltas of one item into one, so a frame of streamed tokens costs one
 * concatenation and one block replacement per item. The folded delta keeps the first one's time, which is when its
 * block started, and the run's clock ends at the last one's.
 */
export function applyEvents(run: RunTranscript, events: readonly AgentEvent[]): void {
  let fold: { delta: Delta; item: string; text: string[]; ts: number } | undefined;
  const settle = () => {
    if (!fold) return;
    project(run, { ...fold.delta, text: fold.text.join("") });
    run.eventAt = fold.ts;
    fold = undefined;
  };
  for (const ev of events) {
    if (!Object.hasOwn(handlers, ev.type) || !admit(run, ev)) continue;
    if (!isDelta(ev)) {
      settle();
      project(run, ev);
      continue;
    }
    const item = itemOf(ev);
    if (fold?.item === item) {
      fold.text.push(ev.text);
      fold.ts = ev.ts;
      continue;
    }
    settle();
    fold = { delta: ev, item, text: [ev.text], ts: ev.ts };
  }
  settle();
}
