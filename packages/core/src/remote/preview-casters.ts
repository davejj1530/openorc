import {
  PREVIEW_INPUT_RATE,
  PREVIEW_INPUT_WORDS,
  type PreviewFocus,
  type PreviewHost,
  type PreviewHostPage,
  type PreviewPace,
  type PreviewState,
  type RemotePush,
  type SessionParams,
  type SessionRpcResults,
} from "@openorc/protocol";
import { previewState } from "../services/preview.js";
import { previewReply, type PhoneShaping } from "./phone-words.js";

/**
 * Intervals while nothing changes, in steps; the first is the pace while the page keeps painting. `interactiveMs` is
 * the pace while a phone drives the page, so what its input did comes back quickly.
 */
export const PREVIEW_PACE = {
  lan: { everyMs: [500, 1000, 2000], interactiveMs: 200, quality: 60, maxWidth: 1600 },
  tailnet: { everyMs: [1000, 2000], interactiveMs: 500, quality: 50, maxWidth: 1200 },
} as const;
/** After an applied input the page paints once, then the caster captures it. */
const AFTER_INPUT_MS = 60;
/** The interactive pace holds this long after the last input. */
const INTERACTIVE_MS = 2_000;
/** Pane events in a burst (a load's start, its title, its stop) leave as one state push. */
const COALESCE_MS = 250;

/** What a caster needs of a phone's session: somewhere to push. The session itself is the watcher's key. */
export type PreviewSession = { push(push: RemotePush): void };

export interface PreviewWatcher {
  session: PreviewSession;
  width: number;
  pace: PreviewPace;
  /** The newest frame this phone was told of. */
  told: number | null;
  /** It fetched that frame: one frame of credit per phone. */
  fetched: boolean;
  toldAt: number;
}

interface Held {
  seq: number;
  jpeg: Uint8Array;
  width: number;
  height: number;
  digest: string;
}

interface Deps extends PhoneShaping {
  host: PreviewHost;
}

/**
 * One watched thread. It captures only while some watcher has fetched the last frame it was told of, so a slow link
 * lowers the rate and a frozen phone stops the captures. An unchanged frame is never announced, and the interval steps
 * up while nothing changes; a pane event steps it back. It holds one frame, in memory, and nothing once unwatched.
 */
class Caster {
  readonly watchers = new Map<PreviewSession, PreviewWatcher>();
  page: PreviewHostPage | null = null;
  held: Held | null = null;
  private seq = 0;
  private step = 0;
  private lastStart = -Infinity;
  /** When a phone's input asks for the next capture, sooner than the interval would. */
  private soon: number | null = null;
  private interactiveUntil = -Infinity;
  private stopped = false;
  /** No page: nothing to capture until a pane event says otherwise. */
  private closed = false;
  private wake: (() => void) | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /** The first reading of the page, which the first watch answers with. */
  readonly ready: Promise<void>;

  constructor(
    private readonly threadId: string,
    private readonly deps: Deps,
  ) {
    this.ready = this.query();
  }

  /** Captures begin once the first watch has its answer, so that answer is the page before any frame. */
  start(): void {
    if (this.running) return this.nudge();
    this.running = true;
    void this.run();
  }

  /** The state as every watcher hears it, shaped once. */
  state(): PreviewState {
    const frame = this.held && { seq: this.held.seq, width: this.held.width, height: this.held.height };
    return previewReply(previewState(this.page, frame), this.deps);
  }

  /** A pane event: the interval steps back now; the state follows, one push per burst. */
  changed(): void {
    this.step = 0;
    this.closed = false;
    this.nudge();
    this.pushTimer ??= setTimeout(() => {
      this.pushTimer = null;
      void this.query().then(() => this.tellAll());
    }, COALESCE_MS);
  }

  /** A phone's input landed: its effect is captured after one paint, and the pace stays quick while input goes on. */
  afterInput(): void {
    const now = Date.now();
    this.step = 0;
    this.closed = false;
    this.interactiveUntil = now + INTERACTIVE_MS;
    // A drag's next input must not push back the capture its first one asked for.
    this.soon ??= now + AFTER_INPUT_MS;
    this.nudge();
  }

  nudge(): void {
    this.wake?.();
  }

  stop(): void {
    this.stopped = true;
    this.held = null;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.nudge();
  }

  private async query(): Promise<void> {
    this.page = await this.deps.host.query(this.threadId).catch(() => this.page);
    if (this.page) return;
    this.closed = true;
    this.held = null;
  }

  private tellAll(): void {
    if (this.stopped) return;
    const push: RemotePush = { type: "preview", threadId: this.threadId, state: this.state() };
    for (const watcher of this.watchers.values()) watcher.session.push(push);
  }

  private interactive(): boolean {
    return Date.now() < this.interactiveUntil;
  }

  /** The gap a route allows between two frames now. */
  private gap(pace: PreviewPace): number {
    return this.interactive() ? PREVIEW_PACE[pace].interactiveMs : PREVIEW_PACE[pace].everyMs[0];
  }

  /** The leanest pace serves only routes that are all lean; one LAN watcher sets the full pace. */
  private settings() {
    const watchers = [...this.watchers.values()];
    const pace = PREVIEW_PACE[watchers.some((watcher) => watcher.pace === "lan") ? "lan" : "tailnet"];
    const width = Math.max(...watchers.map((watcher) => Math.min(watcher.width, PREVIEW_PACE[watcher.pace].maxWidth)));
    const everyMs = this.interactive() ? pace.interactiveMs : pace.everyMs[Math.min(this.step, pace.everyMs.length - 1)]!;
    return { everyMs, quality: pace.quality, width };
  }

  private hasCredit(): boolean {
    return [...this.watchers.values()].some((watcher) => watcher.fetched);
  }

  /** Resolves after `ms`, or sooner on a nudge. */
  private pause(ms?: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = ms === undefined ? undefined : setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const owed = this.announce();
      if (this.closed || !this.hasCredit()) {
        await this.pause(owed === null ? undefined : owed - Date.now());
        continue;
      }
      const { everyMs, quality, width } = this.settings();
      const due = this.soon === null ? this.lastStart + everyMs : Math.max(this.soon, this.lastStart + everyMs);
      const wait = Math.min(due, owed ?? Infinity) - Date.now();
      if (wait > 0) {
        await this.pause(wait);
        continue;
      }
      this.lastStart = Date.now();
      this.soon = null;
      const capture = await this.deps.host.capture(this.threadId, { width, quality, unless: this.held?.digest ?? null }).catch(() => null);
      if (this.stopped) return;
      if (capture?.kind === "frame") {
        this.step = 0;
        this.held = { seq: ++this.seq, jpeg: capture.jpeg, width: capture.width, height: capture.height, digest: capture.digest };
        if (capture.pane !== this.page?.pane) await this.query();
      } else if (capture?.kind === "same") {
        this.step++;
      } else {
        // No frame: either no page any more, or a view laid out at zero size, which keeps the frame held.
        await this.query();
        this.step++;
        if (this.closed) this.tellAll();
      }
    }
  }

  /**
   * The held frame, to each watcher with credit that has not heard of it, once its route allows another one. A watcher
   * whose slot is still closed hears of it later, so a page that stops changing still ends on its last frame. Returns
   * when the next of those slots opens, or null when nobody waits for one.
   */
  private announce(): number | null {
    const held = this.held;
    if (!held) return null;
    const now = Date.now();
    let next: number | null = null;
    let push: RemotePush | null = null;
    for (const watcher of this.watchers.values()) {
      if (!watcher.fetched || (watcher.told ?? 0) >= held.seq) continue;
      const opens = watcher.toldAt + this.gap(watcher.pace) - 50;
      if (opens > now) {
        next = Math.min(next ?? opens, opens);
        continue;
      }
      watcher.told = held.seq;
      watcher.fetched = false;
      watcher.toldAt = now;
      push ??= { type: "preview", threadId: this.threadId, state: this.state() };
      watcher.session.push(push);
    }
    return next;
  }
}

/** The Mac's focus as a phone hears it: a select's labels are page text, so they pass the phone's words. */
function phoneFocus(focus: PreviewFocus | null, words: (message: string) => string): PreviewFocus | null {
  if (focus?.kind !== "choice") return focus;
  return { ...focus, options: focus.options.map((option) => ({ ...option, label: words(option.label) })) };
}

/**
 * Every Preview a phone watches, one caster per thread, paced by the core. A watch belongs to one session and ends
 * with it; frames are served only to a watching session, from the one frame its caster holds.
 */
export class PreviewCasters {
  private readonly casters = new Map<string, Caster>();
  private readonly watching = new Map<PreviewSession, string>();
  /** When each session's inputs of the last second came. */
  private readonly inputs = new WeakMap<PreviewSession, number[]>();
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: Deps) {
    this.unsubscribe = deps.host.onChange((threadId) => this.casters.get(threadId)?.changed());
  }

  /** Replaces the session's earlier watch. The answer carries the newest frame, which the phone may fetch at once. */
  async watch(session: PreviewSession, { threadId, width, pace }: SessionParams<"preview.watch">): Promise<PreviewState> {
    if (this.watching.get(session) !== threadId) this.unwatch(session);
    let caster = this.casters.get(threadId);
    if (!caster) {
      caster = new Caster(threadId, this.deps);
      this.casters.set(threadId, caster);
    }
    const held = caster.held;
    caster.watchers.set(session, { session, width, pace, told: held?.seq ?? null, fetched: held === null, toldAt: -Infinity });
    this.watching.set(session, threadId);
    await caster.ready;
    const state = caster.state();
    caster.start();
    return state;
  }

  /** The watched thread is gone: each watcher hears the watch ended, in the Mac's words, and the caster and its frame go. */
  end(threadId: string, message: string): void {
    const caster = this.casters.get(threadId);
    if (!caster) return;
    this.casters.delete(threadId);
    caster.stop();
    const push: RemotePush = { type: "preview.ended", threadId, message };
    for (const session of caster.watchers.keys()) {
      this.watching.delete(session);
      session.push(push);
    }
  }

  unwatch(session: PreviewSession): void {
    const threadId = this.watching.get(session);
    if (threadId === undefined) return;
    this.watching.delete(session);
    const caster = this.casters.get(threadId);
    caster?.watchers.delete(session);
    if (!caster || caster.watchers.size > 0) return;
    caster.stop();
    this.casters.delete(threadId);
  }

  /**
   * A phone's input on the page it watches, for the pane its frame shows; main checks the pane again, as the core's
   * state can lag a tab switch. Refusals throw in the phone's words.
   */
  async input(session: PreviewSession, { threadId, ...request }: SessionParams<"preview.input">): Promise<SessionRpcResults["preview.input"]> {
    const caster = this.watching.get(session) === threadId ? this.casters.get(threadId) : undefined;
    if (!caster) throw new Error(PREVIEW_INPUT_WORDS.unwatched);
    if (!this.admit(session)) throw new Error(PREVIEW_INPUT_WORDS.rate);
    if (!caster.page) throw new Error(PREVIEW_INPUT_WORDS.closed);
    if (caster.page.pane !== request.pane) throw new Error(PREVIEW_INPUT_WORDS.pane);
    const result = await this.deps.host.input(threadId, request);
    if (!result) throw new Error(PREVIEW_INPUT_WORDS.closed);
    if (result.kind === "refused") {
      if (result.reason === "pane") caster.changed();
      throw new Error(PREVIEW_INPUT_WORDS[result.reason]);
    }
    caster.afterInput();
    return { focus: phoneFocus(result.focus, this.deps.words) };
  }

  /** At most 30 inputs in any second per session. */
  private admit(session: PreviewSession): boolean {
    const now = Date.now();
    const recent = (this.inputs.get(session) ?? []).filter((at) => now - at < PREVIEW_INPUT_RATE.perMs);
    this.inputs.set(session, recent);
    if (recent.length >= PREVIEW_INPUT_RATE.inputs) return false;
    recent.push(now);
    return true;
  }

  /** The newest frame's bytes for a watching session, at most its newest `seq`; fetching it gives the credit back. */
  frame(session: PreviewSession, threadId: string, seq: number): Uint8Array | null {
    const caster = this.casters.get(threadId);
    const watcher = caster?.watchers.get(session);
    const held = caster?.held;
    if (!watcher || !held || seq < 1 || seq > held.seq) return null;
    // Fetching a frame a state push named counts as hearing of it, so the same frame is not announced again after.
    if (seq >= (watcher.told ?? 0)) {
      watcher.told = seq;
      if (!watcher.fetched) caster.nudge();
      watcher.fetched = true;
    }
    return held.jpeg;
  }

  close(): void {
    this.unsubscribe();
    for (const caster of this.casters.values()) caster.stop();
    this.casters.clear();
    this.watching.clear();
  }
}
