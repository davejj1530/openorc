import { BRAIN_AWAY_MS, BRAIN_IDLE_MS, type BrainSelf } from "@openorc/cloud";

export interface AwakeTiming {
  /** How often the policy looks. */
  tickMs: number;
  /** How far each extension moves the stop; also the sandbox's own timeout, so a hung brain stops within it. */
  awayMs: number;
  /** Idle this long, since the last busy moment or the start, and the brain sleeps. */
  idleMs: number;
  /** A busy brain at its session's cap closes this long before the stop. */
  lastCallMs: number;
}

export const AWAKE: AwakeTiming = { tickMs: 60_000, awayMs: BRAIN_AWAY_MS, idleMs: BRAIN_IDLE_MS, lastCallMs: 60_000 };

export interface AwakeState {
  /** The last moment anything was busy. Starts at the start: a brain someone just woke waits for them. */
  lastBusyAt: number;
  /** When the sandbox stops unless extended, as the last extension reported; null before the first. */
  expiresAt: number | null;
  /** The last extension did not move the stop: the plan's longest session holds it. Stop and resume reset it. */
  capped: boolean;
}

export type SleepReason = "idle" | "session-limit";
export type AwakeAction = { kind: "extend"; forMs: number } | { kind: "sleep"; why: SleepReason } | { kind: "wait" };

/** What one look decided, and when to look again. */
export interface AwakeDecision {
  state: AwakeState;
  action: AwakeAction;
  next: number;
}

/** The whole keep-awake policy as one pure step, so it is tested as a table. */
export function decide(state: AwakeState, seen: { now: number; busy: string | null }, timing: AwakeTiming = AWAKE): AwakeDecision {
  const next = { ...state, lastBusyAt: seen.busy ? seen.now : state.lastBusyAt };
  const tick = seen.now + timing.tickMs;
  if (!seen.busy && seen.now - next.lastBusyAt >= timing.idleMs) return { state: next, action: { kind: "sleep", why: "idle" }, next: tick };
  if (state.capped && state.expiresAt !== null) {
    const lastCall = state.expiresAt - timing.lastCallMs;
    // Extending cannot help any more: an idle brain goes now, a busy one lets its work use what is left.
    if (!seen.busy || seen.now >= lastCall) return { state: next, action: { kind: "sleep", why: "session-limit" }, next: tick };
    return { state: next, action: { kind: "wait" }, next: Math.min(tick, lastCall) };
  }
  return { state: next, action: { kind: "extend", forMs: timing.awayMs }, next: tick };
}

/** A brain in a local container has no sandbox to extend or stop: it just exits when it sleeps. */
export const NO_SANDBOX: BrainSelf = {
  extend: async (forMs) => ({ expiresAt: Date.now() + forMs, capped: false }),
  stop: async () => undefined,
  region: () => Promise.reject(new Error("A brain in a local container has no sandbox.")),
};

export interface BrainAwakeDeps {
  /** Why the brain must stay up now, or null when nothing would be cut short. */
  busy(): string | null;
  self: BrainSelf;
  /**
   * Closes the core and stops the sandbox. Returns when it decided not to, because something became busy. Not asked
   * of a brain whose sleep keeps its process: that one sleeps with its core open.
   */
  sleep(why: SleepReason): Promise<void>;
  warn(text: string): void;
  now?: () => number;
}

/** Runs `decide` now and then on its schedule, and acts on it. */
export class BrainAwake {
  private state: AwakeState;
  private timer: NodeJS.Timeout | null = null;
  /** When the next look is due; null before the first. */
  private due: number | null = null;
  private stopped = false;
  private failing = false;
  private readonly now: () => number;

  constructor(
    private readonly deps: BrainAwakeDeps,
    private readonly timing: AwakeTiming = AWAKE,
  ) {
    this.now = deps.now ?? Date.now;
    this.state = { lastBusyAt: this.now(), expiresAt: null, capped: false };
  }

  /** Extends at once, since a resumed sandbox has only its default timeout left, then looks on schedule. */
  start(): void {
    void this.look();
  }

  /** Someone asked the brain something: the idle clock starts again. */
  touch(): void {
    this.state = { ...this.state, lastBusyAt: this.now() };
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private async look(): Promise<void> {
    if (this.stopped) return;
    // A look this late means the machine slept with the brain in it and woke since: the idle clock starts over, as at a
    // start, so whoever woke it gets the whole grace.
    if (this.due !== null && this.now() - this.due > this.timing.tickMs) this.touch();
    const decision = decide(this.state, { now: this.now(), busy: this.deps.busy() }, this.timing);
    this.state = decision.state;
    await this.act(decision.action);
    if (this.stopped) return;
    this.due = decision.next;
    this.timer = setTimeout(() => void this.look(), Math.max(0, decision.next - this.now()));
    this.timer.unref();
  }

  private async act(action: AwakeAction): Promise<void> {
    if (action.kind === "sleep") return this.deps.self.keepsProcesses ? this.nap() : this.deps.sleep(action.why);
    if (action.kind === "wait") return;
    try {
      const { expiresAt, capped } = await this.deps.self.extend(action.forMs);
      this.state = { ...this.state, expiresAt, capped };
      this.failing = false;
    } catch (error) {
      // Once per run of failures; the sandbox's own timeout still stops a brain that cannot extend.
      if (!this.failing) this.deps.warn(`Could not keep the brain awake: ${error instanceof Error ? error.message : String(error)}`);
      this.failing = true;
    }
  }

  /**
   * Sleeps a machine that keeps the brain's process, with the core open: the brain goes on where it was once woken. The
   * call may answer only after that wake, or fail across it; either way the idle clock starts over then.
   */
  private async nap(): Promise<void> {
    await this.deps.self.stop().catch((error: unknown) => this.deps.warn(`Could not put the brain to sleep: ${error instanceof Error ? error.message : String(error)}`));
    this.touch();
  }
}
