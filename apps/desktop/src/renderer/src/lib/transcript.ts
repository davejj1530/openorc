import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { ActivityStatus, AgentEvent, Frame, McpToolSource } from "@openorc/protocol";
import { core } from "./rpc";

/**
 * Transcript projection. Events fold into blocks. A change replaces only the blocks it touches and the arrays that
 * hold them, and each run is its own snapshot, so a component showing one run ignores every other run's stream.
 * Live runs feed from frames; the rest load from the ledger, newest turns first, and leave memory a few minutes
 * after nothing shows them.
 */
export type Block = { at?: number; turnKey?: string; runId?: string } & (
  | { id: string; kind: "message"; role: "assistant" | "user" | "system"; text: string; streaming: boolean; at?: number; attachments?: string[]; runId?: string }
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
      mcp?: McpToolSource;
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
      recovery?: { kind: "usage"; provider: "codex" | "claude" };
    }
  | { id: string; kind: "approval"; approvalId: string; approvalKind: string; toolName?: string; input: unknown; reason?: string; decision?: string; answers?: Record<string, string[]> }
  | { id: string; kind: "status"; text: string; tone: "muted" | "ok" | "bad"; boundary?: "turn" | "session"; durationMs?: number; outcome?: "success" | "error" | "cancelled" }
);

export interface RunTranscript {
  runId: string;
  blocks: Block[];
  blockIndex: Map<string, number>;
  live: boolean;
  hydrated: boolean;
  /** The first turn loaded from the ledger. 0 once the whole run is here, which a run seen from its start always is. */
  fromTurn: number;
  eventCount: number;
  /** Timestamp of the event being projected, including history replay. */
  eventAt?: number;
  eventIds?: Set<string>;
  /** Turns finished before the newest block, counted from the run's start even when earlier turns are not loaded. */
  turnsCompleted: number;
  /** Which turn of this process each block belongs to. A warm session's transcript holds several turns. */
  turnOf: Map<string, number>;
  pendingApprovals: number;
  /** The agent's stderr. Kept off the transcript; the ledger has it all. */
  stderr: string[];
}

interface TranscriptState {
  /** A new map and a new run object whenever a run changes; unchanged runs keep their identity. */
  runs: ReadonlyMap<string, RunTranscript>;
}

export const useTranscripts = create<TranscriptState>(() => ({ runs: new Map() }));

/** Runs as of the last event, ahead of what subscribers have been told by at most one animation frame. */
let current = new Map<string, RunTranscript>();
let scheduled = false;
const hydrating = new Map<string, Frame[]>();
const loads = new Map<string, Promise<void>>();

export function emptyRun(runId: string): RunTranscript {
  return { runId, blocks: [], blockIndex: new Map(), live: false, hydrated: false, fromTurn: 0, eventCount: 0, turnsCompleted: 0, turnOf: new Map(), pendingApprovals: 0, stderr: [] };
}

/** Tells subscribers about everything changed since the last time. */
export function flushTranscripts(): void {
  if (!scheduled) return;
  scheduled = false;
  useTranscripts.setState({ runs: current });
}

/** At most one update per animation frame, however many runs stream; a hidden window paints none, so a timer stands in. */
function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(flushTranscripts);
  setTimeout(flushTranscripts, 100);
}

/** The runs map, copied once after each publish so subscribers keep the snapshot they were given. */
function writable(): Map<string, RunTranscript> {
  if (current === useTranscripts.getState().runs) current = new Map(current);
  return current;
}

/**
 * A fresh copy of a run for one frame's events. Whoever read the previous copy keeps it unchanged, so a memo keyed
 * on a run or its blocks sees every change. Blocks themselves are replaced, never changed, when an event updates them.
 */
function edit(runId: string): RunTranscript {
  const existing = current.get(runId);
  const run = existing ? { ...existing, blocks: existing.blocks.slice() } : emptyRun(runId);
  replace(run);
  return run;
}

function replace(run: RunTranscript): void {
  writable().set(run.runId, run);
  schedule();
  // A run no view holds, such as one streaming in a thread that is not open, leaves memory like one a view let go.
  if (!holds.has(run.runId) && !evictions.has(run.runId)) scheduleEviction(run.runId);
}

export function applyFrame(frame: Frame): void {
  const buffered = hydrating.get(frame.runId);
  if (buffered) {
    buffered.push(frame);
    return;
  }
  const run = edit(frame.runId);
  for (const ev of frame.events) applyEvent(run, ev);
  run.eventCount += frame.events.length;
}

/** What to load: the newest `turns`, or everything from `fromTurn` on (the whole run when omitted). */
export type LoadRequest = { turns: number } | { fromTurn?: number };

/**
 * Rebuilds a run from the ledger, unless what is loaded already covers the request. Frames that arrive meanwhile
 * are replayed after. Resolves once the request is covered, including by a load already in flight.
 */
export async function hydrate(runId: string, request: LoadRequest = {}): Promise<void> {
  for (;;) {
    // A load already in flight is awaited, and its failure is the caller's too rather than a cue to start another.
    const pending = loads.get(runId);
    if (pending) {
      await pending;
      continue;
    }
    const run = current.get(runId);
    if (run?.hydrated && ("turns" in request || run.fromTurn <= (request.fromTurn ?? 0))) return;
    const load = loadPage(runId, request).finally(() => loads.delete(runId));
    loads.set(runId, load);
    return load;
  }
}

async function loadPage(runId: string, request: LoadRequest): Promise<void> {
  hydrating.set(runId, []);
  try {
    const page = await core.call("events.page", { runId, ...request });
    const run = emptyRun(runId);
    run.hydrated = true;
    run.fromTurn = page.fromTurn;
    // Turns before the page still count, so turn numbers match checkpoints and team attempts.
    run.turnsCompleted = page.fromTurn;
    for (const ev of page.events) applyEvent(run, ev);
    // A page that starts after the session did has no session.started to say whether it is still open.
    if (page.fromTurn > 0) run.live = page.live;
    // The listing already reflects every buffered event up to the last one it holds, including streaming fragments
    // the ledger has since dropped because their completion replaced them. Only what came after is new.
    const buffered = (hydrating.get(runId) ?? []).flatMap((frame) => frame.events);
    const listed = new Set(page.events.map((ev) => ev.eventId));
    const seen = buffered.findLastIndex((ev) => ev.eventId !== undefined && listed.has(ev.eventId));
    for (const ev of buffered.slice(seen + 1)) applyEvent(run, ev);
    run.eventCount = page.events.length + buffered.length - seen - 1;
    keepUnchanged(run, current.get(runId));
    replace(run);
  } finally {
    hydrating.delete(runId);
    flushTranscripts();
  }
}

/**
 * Puts back the previous objects of blocks a reload left as they were, so loading older turns re-renders only
 * those turns and not every one already on screen.
 */
function keepUnchanged(run: RunTranscript, previous: RunTranscript | undefined): void {
  if (!previous) return;
  run.blocks = run.blocks.map((block) => {
    const index = previous.blockIndex.get(block.id);
    const before = index === undefined ? undefined : previous.blocks[index];
    return before && sameJson(before, block) ? before : block;
  });
}

/** Deep equality for plain parsed JSON, which is all a block holds. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

export function getRun(runId: string): RunTranscript | undefined {
  return current.get(runId);
}

/** Empties the store, for tests and fixtures. */
export function resetTranscripts(): void {
  current = new Map();
  hydrating.clear();
  loads.clear();
  for (const timer of evictions.values()) clearTimeout(timer);
  evictions.clear();
  holds.clear();
  scheduled = false;
  useTranscripts.setState({ runs: current });
}

/** Seeds a run directly, for fixtures that stage a transcript without events. */
export function seedRun(run: RunTranscript): void {
  replace(run);
  flushTranscripts();
}

core.onFrame(applyFrame);

/* Keeping runs in memory only while something shows them */

/** How long a run stays loaded after the last view of it closes, so returning to a thread is instant. */
const EVICT_AFTER_MS = 3 * 60_000;
const holds = new Map<string, number>();
const evictions = new Map<string, ReturnType<typeof setTimeout>>();

/** Keeps runs loaded until the returned release is called. Views of the same run share it. */
export function retainRuns(runIds: readonly string[]): () => void {
  for (const id of runIds) {
    holds.set(id, (holds.get(id) ?? 0) + 1);
    clearTimeout(evictions.get(id));
    evictions.delete(id);
  }
  return () => {
    for (const id of runIds) {
      const count = (holds.get(id) ?? 1) - 1;
      if (count > 0) holds.set(id, count);
      else {
        holds.delete(id);
        scheduleEviction(id);
      }
    }
  };
}

function scheduleEviction(runId: string): void {
  clearTimeout(evictions.get(runId));
  evictions.set(
    runId,
    setTimeout(() => {
      evictions.delete(runId);
      const run = current.get(runId);
      if (!run || holds.has(runId)) return;
      // A live run keeps streaming and a waiting approval counts toward the inbox; both stay until they settle.
      if (run.live || run.pendingApprovals > 0 || hydrating.has(runId)) return scheduleEviction(runId);
      writable().delete(runId);
      schedule();
    }, EVICT_AFTER_MS),
  );
}

/* Subscriptions */

const NO_RUNS: readonly string[] = [];

function useRetained(runIds: readonly string[]): void {
  const key = runIds.join("\n");
  useEffect(() => retainRuns(key ? key.split("\n") : NO_RUNS), [key]);
}

/** One run, re-rendering only when it changes, and kept loaded while shown. */
export function useRun(runId: string | undefined): RunTranscript | undefined {
  useRetained(runId ? [runId] : NO_RUNS);
  return useTranscripts((state) => (runId ? state.runs.get(runId) : undefined));
}

/** Several runs, re-rendering only when one of them changes, and kept loaded while shown. */
export function useRuns(runIds: readonly string[]): (RunTranscript | undefined)[] {
  useRetained(runIds);
  return useTranscripts(useShallow((state) => runIds.map((id) => state.runs.get(id))));
}

/** Several runs by id, for helpers that look them up in a map. */
export function useRunMap(runIds: readonly string[]): ReadonlyMap<string, RunTranscript> {
  const runs = useRuns(runIds);
  return useMemo(() => new Map(runs.flatMap((run) => (run ? [[run.runId, run] as const] : []))), [runs]);
}

/** Approvals waiting across every loaded run, for the inbox count. */
export function usePendingApprovals(): number {
  return useTranscripts((state) => {
    let pending = 0;
    for (const run of state.runs.values()) pending += run.pendingApprovals;
    return pending;
  });
}

function upsert(run: RunTranscript, block: Block): void {
  const i = run.blockIndex.get(block.id);
  const previous = i === undefined ? undefined : run.blocks[i];
  block = { ...block, runId: run.runId, at: previous?.at ?? block.at ?? run.eventAt, turnKey: previous?.turnKey ?? `${run.runId}:${run.turnsCompleted}` };
  if (i === undefined) {
    run.turnOf.set(block.id, run.turnsCompleted);
    run.blockIndex.set(block.id, run.blocks.length);
    run.blocks.push(block);
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

/** Terminal boundaries also cover items whose provider never sent completion. */
function closeActive(run: RunTranscript, ts: number, status: ActivityStatus): void {
  for (const block of run.blocks) {
    if (block.kind === "thinking" && block.endedAt === null) upsert(run, { ...block, endedAt: ts, status });
    if (block.kind === "tool" && !block.done) upsert(run, { ...block, done: true, status, isError: status === "error" });
    if (block.kind === "activity" && block.status === "running") upsert(run, { ...block, status });
    if (block.kind === "message" && block.streaming) upsert(run, { ...block, streaming: false });
    if (block.kind === "approval" && !block.decision) upsert(run, { ...block, decision: "expired" });
  }
  run.pendingApprovals = 0;
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

function applyEvent(run: RunTranscript, ev: AgentEvent): void {
  if (ev.eventId) {
    run.eventIds ??= new Set();
    if (run.eventIds.has(ev.eventId)) return;
    run.eventIds.add(ev.eventId);
  }
  run.eventAt = ev.ts;
  if (!ev.type.startsWith("thinking.") && ev.type !== "raw" && ev.type !== "usage.updated" && ev.type !== "background.updated") closeThinking(run, ev.ts);
  switch (ev.type) {
    case "session.started":
      run.live = true;
      upsert(run, { id: "status-start", kind: "status", tone: "muted", text: `${ev.agent} session started${ev.model ? ` with ${ev.model}` : ""}` });
      return;
    case "message.delta": {
      const existing = get(run, ev.messageId, "message");
      upsert(run, { id: ev.messageId, kind: "message", role: ev.role, text: (existing?.text ?? "") + ev.text, streaming: true, at: existing?.at ?? ev.ts });
      return;
    }
    case "message.completed": {
      const existing = get(run, ev.messageId, "message");
      upsert(run, { id: ev.messageId, kind: "message", role: ev.role, text: ev.text, streaming: false, at: existing?.at ?? ev.ts, ...(ev.attachments ? { attachments: ev.attachments } : {}) });
      return;
    }
    case "thinking.started": {
      const id = `think-${ev.messageId}`;
      const existing = get(run, id, "thinking");
      if (!existing) upsert(run, { id, kind: "thinking", text: "", startedAt: ev.ts, endedAt: null, explicit: true });
      return;
    }
    case "thinking.completed": {
      const id = `think-${ev.messageId}`;
      const existing = get(run, id, "thinking");
      upsert(run, { id, kind: "thinking", text: ev.text || existing?.text || "", startedAt: existing?.startedAt ?? ev.ts, endedAt: ev.ts, explicit: true, status: "success" });
      return;
    }
    case "activity.updated": {
      const id = `activity-${ev.activityId}`;
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
      return;
    }
    case "activity.delta": {
      const id = `activity-${ev.activityId}`;
      const existing = get(run, id, "activity");
      upsert(run, { ...existing, id, kind: "activity", label: ev.label, status: existing?.status ?? "running", text: (existing?.text ?? "") + ev.text });
      return;
    }
    case "thinking.delta": {
      const id = `think-${ev.messageId}`;
      const existing = get(run, id, "thinking");
      upsert(run, { ...existing, id, kind: "thinking", text: (existing?.text ?? "") + ev.text, startedAt: existing?.startedAt ?? ev.ts, endedAt: existing?.endedAt ?? null });
      return;
    }
    case "tool.started":
      upsert(run, { id: ev.toolCallId, kind: "tool", name: ev.name, input: ev.input, done: false, ...(ev.mcp ? { mcp: ev.mcp } : {}) });
      return;
    case "tool.output.delta": {
      const existing = get(run, ev.toolCallId, "tool");
      if (existing) upsert(run, { ...existing, output: (typeof existing.output === "string" ? existing.output : "") + ev.text });
      return;
    }
    case "tool.updated": {
      const existing = get(run, ev.toolCallId, "tool");
      if (existing)
        upsert(run, { ...existing, ...(ev.input !== undefined ? { input: ev.input } : {}), ...(ev.progress !== undefined ? { progress: ev.progress } : {}), ...(ev.mcp ? { mcp: ev.mcp } : {}) });
      return;
    }
    case "tool.completed": {
      const existing = get(run, ev.toolCallId, "tool");
      upsert(run, {
        id: ev.toolCallId,
        kind: "tool",
        name: ev.name,
        input: ev.input ?? existing?.input,
        // An output left out of the page is read when the row opens, never pieced together from a kept fragment.
        ...(ev.outputOmitted ? { outputOmitted: true } : { output: ev.output ?? existing?.output }),
        ...((ev.mcp ?? existing?.mcp) ? { mcp: ev.mcp ?? existing?.mcp } : {}),
        isError: ev.isError,
        done: true,
        status: ev.status ?? (ev.isError ? "error" : "success"),
        ...(existing?.progress ? { progress: existing.progress } : {}),
      });
      return;
    }
    case "approval.requested":
      run.pendingApprovals += 1;
      upsert(run, {
        id: `approval-${ev.approvalId}`,
        kind: "approval",
        approvalId: ev.approvalId,
        approvalKind: ev.kind,
        input: ev.input,
        ...(ev.toolName ? { toolName: ev.toolName } : {}),
        ...(ev.reason ? { reason: ev.reason } : {}),
      });
      return;
    case "approval.resolved": {
      const existing = get(run, `approval-${ev.approvalId}`, "approval");
      if (existing && !existing.decision) run.pendingApprovals = Math.max(0, run.pendingApprovals - 1);
      if (existing) upsert(run, { ...existing, decision: ev.decision, ...(ev.answers ? { answers: ev.answers } : {}) });
      return;
    }
    case "turn.completed":
      closeActive(run, ev.ts, completionOutcome(ev.status));
      upsert(run, {
        id: `turn-${ev.turnId}`,
        boundary: "turn",
        durationMs: ev.durationMs,
        outcome: completionOutcome(ev.status),
        kind: "status",
        tone: ev.status === "success" ? "ok" : "bad",
        text: `turn ${ev.status === "success" ? "finished" : ev.status} in ${(ev.durationMs / 1000).toFixed(1)}s${ev.usage ? `, ${ev.usage.inputTokens.toLocaleString()} in / ${ev.usage.outputTokens.toLocaleString()} out` : ""}`,
      });
      run.turnsCompleted += 1;
      return;
    case "session.completed":
      closeActive(run, ev.ts, sessionCloseStatus(ev.status));
      run.live = false;
      run.pendingApprovals = 0;
      upsert(run, {
        id: "status-end",
        boundary: "session",
        outcome: completionOutcome(ev.status),
        kind: "status",
        tone: ev.status === "success" ? "muted" : "bad",
        text: `session ${ev.status === "success" ? "closed" : ev.status}`,
      });
      return;
    case "error":
      if (ev.fatal) {
        closeActive(run, ev.ts, "error");
        run.live = false;
        upsert(run, { id: `err-${ev.ts}-${run.blocks.length}`, kind: "status", boundary: "session", outcome: "error", tone: "bad", text: ev.message });
      } else {
        run.stderr.push(ev.message);
        if (run.stderr.length > 500) run.stderr.shift();
      }
      return;
    case "file.changed":
    case "usage.updated":
    case "background.updated":
    case "raw":
      return;
  }
}
