import { useEffect, useMemo } from "react";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { Frame } from "@openorc/protocol";
import type { CoreConnection } from "./connection.js";
import { applyEvents, emptyRun, type RunTranscript } from "./transcript.js";

/** How long a run stays loaded after the last view of it closes, so returning to a thread is instant. */
const EVICT_AFTER_MS = 3 * 60_000;

/** What to load: the newest `turns`, or everything from `fromTurn` on (the whole run when omitted). */
export type LoadRequest = { turns: number } | { fromTurn?: number };

interface Published {
  /** A new map and a new run object whenever a run changes; unchanged runs keep their identity. */
  runs: ReadonlyMap<string, RunTranscript>;
  /**
   * Runs whose last load from the ledger failed. Views leave them until a resync, after which calls may work again,
   * or until another view takes hold of them and asks afresh.
   */
  failed: ReadonlySet<string>;
}

/**
 * The runs a client keeps. Live runs feed from frames; the rest load from the ledger, newest turns first, and leave
 * memory a few minutes after nothing shows them.
 */
interface Store {
  readonly connection: CoreConnection;
  readonly scheduleFrame: (callback: () => void) => void;
  readonly published: UseBoundStore<StoreApi<Published>>;
  /** Runs as of the last event, ahead of what subscribers have been told by at most one animation frame. */
  current: Map<string, RunTranscript>;
  scheduled: boolean;
  readonly hydrating: Map<string, Frame[]>;
  readonly loads: Map<string, Promise<void>>;
  readonly holds: Map<string, number>;
  readonly evictions: Map<string, ReturnType<typeof setTimeout>>;
  /** The run ids an interest connection was last told. */
  interest: ReadonlySet<string>;
}

/** Tells subscribers about everything changed since the last time. */
function flush(s: Store): void {
  if (!s.scheduled) return;
  s.scheduled = false;
  s.published.setState({ runs: s.current });
}

/** At most one update per animation frame, however many runs stream; a hidden window paints none, so a timer stands in. */
function schedule(s: Store): void {
  if (s.scheduled) return;
  s.scheduled = true;
  s.scheduleFrame(() => flush(s));
  setTimeout(() => flush(s), 100);
}

/** The runs map, copied once after each publish so subscribers keep the snapshot they were given. */
function writable(s: Store): Map<string, RunTranscript> {
  if (s.current === s.published.getState().runs) s.current = new Map(s.current);
  return s.current;
}

/** The runs whose frames this client needs: shown ones, loading ones, and ones in memory that loaded or are live. */
function interestOf(s: Store): Set<string> {
  const ids = new Set([...s.holds.keys(), ...s.hydrating.keys()]);
  for (const run of s.current.values()) if (run.hydrated || run.live) ids.add(run.runId);
  return ids;
}

/** Interest is derived, never kept by hand: every change that could move it tells an interest connection at once. */
function syncInterest(s: Store): void {
  if (s.connection.delivery !== "interest") return;
  const next = interestOf(s);
  if (next.size === s.interest.size && [...next].every((id) => s.interest.has(id))) return;
  s.interest = next;
  s.connection.setFrameInterest(next);
}

/**
 * A fresh copy of a run for one frame's events. Whoever read the previous copy keeps it unchanged, so a memo keyed
 * on a run or its blocks sees every change. Blocks themselves are replaced, never changed, when an event updates them.
 */
function edit(s: Store, runId: string): RunTranscript {
  const existing = s.current.get(runId);
  const run = existing ? { ...existing, blocks: existing.blocks.slice() } : emptyRun(runId);
  replace(s, run);
  return run;
}

function replace(s: Store, run: RunTranscript): void {
  writable(s).set(run.runId, run);
  schedule(s);
  // A run no view holds, such as one streaming in a thread that is not open, leaves memory like one a view let go.
  if (!s.holds.has(run.runId) && !s.evictions.has(run.runId)) scheduleEviction(s, run.runId);
}

function applyFrame(s: Store, frame: Frame): void {
  const buffered = s.hydrating.get(frame.runId);
  if (buffered) {
    buffered.push(frame);
    return;
  }
  const run = edit(s, frame.runId);
  applyEvents(run, frame.events);
  run.eventCount += frame.events.length;
  syncInterest(s);
}

/**
 * Rebuilds a run from the ledger, unless what is loaded already covers the request. Frames that arrive meanwhile
 * are replayed after. Resolves once the request is covered, including by a load already in flight.
 */
async function hydrate(s: Store, runId: string, request: LoadRequest = {}): Promise<void> {
  for (;;) {
    // A load already in flight is awaited, and its failure is the caller's too rather than a cue to start another.
    const pending = s.loads.get(runId);
    if (pending) {
      await pending;
      continue;
    }
    const run = s.current.get(runId);
    if (run?.hydrated && ("turns" in request || run.fromTurn <= (request.fromTurn ?? 0))) return;
    return load(s, runId, request);
  }
}

function load(s: Store, runId: string, request: LoadRequest): Promise<void> {
  const loading = loadPage(s, runId, request).finally(() => s.loads.delete(runId));
  s.loads.set(runId, loading);
  return loading;
}

async function loadPage(s: Store, runId: string, request: LoadRequest): Promise<void> {
  s.hydrating.set(runId, []);
  // Frames for the run are asked for before its page, so none fall between the two.
  syncInterest(s);
  try {
    const page = await s.connection.call("events.page", { runId, ...request });
    const run = emptyRun(runId);
    run.hydrated = true;
    run.fromTurn = page.fromTurn;
    // Turns before the page still count, so turn numbers match checkpoints and team attempts.
    run.turnsCompleted = page.fromTurn;
    applyEvents(run, page.events);
    // A page that starts after the session did has no session.started to say whether it is still open.
    if (page.fromTurn > 0) run.live = page.live;
    if (!run.live) run.turnOpen = false;
    // The listing already reflects every buffered event up to the last one it holds, including streaming fragments
    // the ledger has since dropped because their completion replaced them. Only what came after is new.
    const buffered = (s.hydrating.get(runId) ?? []).flatMap((frame) => frame.events);
    const listed = new Set(page.events.map((ev) => ev.eventId));
    const seen = buffered.findLastIndex((ev) => ev.eventId !== undefined && listed.has(ev.eventId));
    applyEvents(run, buffered.slice(seen + 1));
    run.eventCount = page.events.length + buffered.length - seen - 1;
    keepUnchanged(run, s.current.get(runId));
    replace(s, run);
    forgetFailures(s, [runId]);
  } catch (error) {
    s.published.setState(({ failed }) => ({ failed: new Set(failed).add(runId) }));
    throw error;
  } finally {
    s.hydrating.delete(runId);
    syncInterest(s);
    flush(s);
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

/**
 * After pushes may have been missed: a run something shows reloads over the window it had, waiting for any load in
 * flight; any other run leaves memory, since frames alone cannot fill what was missed. A run that never loaded from
 * the ledger leaves too, and the views that need its history load it again. Never rejects: a run that fails to
 * reload stays as it was.
 */
async function resync(s: Store, runIds?: readonly string[]): Promise<void> {
  forgetFailures(s, runIds ?? [...s.published.getState().failed]);
  await Promise.allSettled((runIds ?? [...s.current.keys()]).map((runId) => (s.holds.has(runId) ? reload(s, runId) : drop(s, runId))));
}

function forgetFailures(s: Store, runIds: readonly string[]): void {
  const { failed } = s.published.getState();
  if (!runIds.some((runId) => failed.has(runId))) return;
  const next = new Set(failed);
  for (const runId of runIds) next.delete(runId);
  s.published.setState({ failed: next });
}

async function reload(s: Store, runId: string): Promise<void> {
  for (let pending = s.loads.get(runId); pending; pending = s.loads.get(runId)) await pending.catch(() => undefined);
  const run = s.current.get(runId);
  if (!run?.hydrated) return drop(s, runId);
  return load(s, runId, { fromTurn: run.fromTurn });
}

function drop(s: Store, runId: string): void {
  if (!s.current.has(runId)) return;
  writable(s).delete(runId);
  schedule(s);
  syncInterest(s);
}

/** Empties the store, for tests and fixtures, and for a client that moves to another core. */
function reset(s: Store): void {
  s.current = new Map();
  s.hydrating.clear();
  s.loads.clear();
  for (const timer of s.evictions.values()) clearTimeout(timer);
  s.evictions.clear();
  s.holds.clear();
  s.scheduled = false;
  s.published.setState({ runs: s.current, failed: new Set() });
  syncInterest(s);
}

/** Seeds a run directly, for fixtures that stage a transcript without events. */
function seed(s: Store, run: RunTranscript): void {
  replace(s, run);
  syncInterest(s);
  flush(s);
}

/** Keeps runs loaded until the returned release is called. Views of the same run share it. */
function retain(s: Store, runIds: readonly string[]): () => void {
  forgetFailures(s, runIds);
  for (const id of runIds) {
    s.holds.set(id, (s.holds.get(id) ?? 0) + 1);
    clearTimeout(s.evictions.get(id));
    s.evictions.delete(id);
  }
  syncInterest(s);
  return () => {
    for (const id of runIds) {
      const count = (s.holds.get(id) ?? 1) - 1;
      if (count > 0) s.holds.set(id, count);
      else {
        s.holds.delete(id);
        scheduleEviction(s, id);
      }
    }
    syncInterest(s);
  };
}

function scheduleEviction(s: Store, runId: string): void {
  clearTimeout(s.evictions.get(runId));
  s.evictions.set(
    runId,
    setTimeout(() => {
      s.evictions.delete(runId);
      const run = s.current.get(runId);
      if (!run || s.holds.has(runId)) return;
      // A live run keeps streaming and a waiting approval counts toward the inbox; both stay until they settle.
      if (run.live || run.pendingApprovals > 0 || s.hydrating.has(runId)) return scheduleEviction(s, runId);
      drop(s, runId);
    }, EVICT_AFTER_MS),
  );
}

const NO_RUNS: readonly string[] = [];

function useRetained(s: Store, runIds: readonly string[]): void {
  const key = runIds.join("\n");
  useEffect(() => retain(s, key ? key.split("\n") : NO_RUNS), [s, key]);
}

/** One run, re-rendering only when it changes, and kept loaded while shown. */
function useRunOf(s: Store, runId: string | undefined): RunTranscript | undefined {
  useRetained(s, runId ? [runId] : NO_RUNS);
  return s.published((state) => (runId ? state.runs.get(runId) : undefined));
}

/** Several runs, re-rendering only when one of them changes, and kept loaded while shown. */
function useRunsOf(s: Store, runIds: readonly string[]): (RunTranscript | undefined)[] {
  useRetained(s, runIds);
  return s.published(useShallow((state) => runIds.map((id) => state.runs.get(id))));
}

/** Several runs by id, for helpers that look them up in a map. */
function useRunMapOf(s: Store, runIds: readonly string[]): ReadonlyMap<string, RunTranscript> {
  const runs = useRunsOf(s, runIds);
  return useMemo(() => new Map(runs.flatMap((run) => (run ? [[run.runId, run] as const] : []))), [runs]);
}

/** Runs whose last load failed, so a view stops asking for them until the store says they may load again. */
function useFailedLoadsOf(s: Store): ReadonlySet<string> {
  return s.published((state) => state.failed);
}

/** Approvals waiting across every loaded run, for the inbox count. */
function usePendingApprovalsOf(s: Store): number {
  return s.published((state) => {
    let pending = 0;
    for (const run of state.runs.values()) pending += run.pendingApprovals;
    return pending;
  });
}

export function createRunStore(connection: CoreConnection, scheduleFrame: (callback: () => void) => void) {
  const s: Store = {
    connection,
    scheduleFrame,
    published: create<Published>(() => ({ runs: new Map(), failed: new Set() })),
    current: new Map(),
    scheduled: false,
    hydrating: new Map(),
    loads: new Map(),
    holds: new Map(),
    evictions: new Map(),
    interest: new Set(),
  };
  return {
    /** The store outside React: views use the hooks; loads, fixtures, tests and background readers use this. */
    runs: {
      get: (runId: string): RunTranscript | undefined => s.current.get(runId),
      hydrate: (runId: string, request?: LoadRequest) => hydrate(s, runId, request),
      retain: (runIds: readonly string[]) => retain(s, runIds),
      resync: (runIds?: readonly string[]) => resync(s, runIds),
      applyFrame: (frame: Frame) => applyFrame(s, frame),
      seed: (run: RunTranscript) => seed(s, run),
      reset: () => reset(s),
      flush: () => flush(s),
      /** What views were last told; changes once per published update. */
      snapshot: (): ReadonlyMap<string, RunTranscript> => s.published.getState().runs,
      subscribe: (listener: (runs: ReadonlyMap<string, RunTranscript>) => void) => s.published.subscribe((state) => listener(state.runs)),
    },
    useRun: (runId: string | undefined) => useRunOf(s, runId),
    useRuns: (runIds: readonly string[]) => useRunsOf(s, runIds),
    useRunMap: (runIds: readonly string[]) => useRunMapOf(s, runIds),
    useFailedLoads: () => useFailedLoadsOf(s),
    usePendingApprovals: () => usePendingApprovalsOf(s),
  };
}

export type RunStore = ReturnType<typeof createRunStore>["runs"];
