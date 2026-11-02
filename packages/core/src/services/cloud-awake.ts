import type { Sandbox } from "@openorc/cloud";
import type { Logger } from "../transport.js";

/** How often a held VM is kept awake, at most; always well inside its away window. */
const KEEP_AWAKE_EVERY_MS = 60_000;
/**
 * How long a VM stays up once nothing holds it, at most: the next turn often follows its preparation, or a message
 * comes soon after an idle agent closed, and stopping and starting a VM takes longer than this costs.
 */
const LINGER_MS = 60_000;

interface Held {
  holds: number;
  timer: ReturnType<typeof setInterval>;
  linger: ReturnType<typeof setTimeout> | null;
}

/**
 * Keeps each conversation's VM awake while something needs it: its preparation, or an agent's process. A little after
 * nothing does, `released` runs and the caller lets the VM go. When the Mac sleeps or OpenOrc quits instead, the VM
 * keeps going for its away window, so a turn in flight can finish, and then stops on its own.
 */
export class CloudAwake {
  private readonly held = new Map<string, Held>();

  constructor(
    private readonly options: {
      released: (threadId: string) => void;
      log: Logger;
    },
  ) {}

  /** Keeps the conversation's VM awake until the returned function is called. Calling it again does nothing. */
  hold(threadId: string, sandbox: Sandbox): () => void {
    const entry = this.held.get(threadId) ?? this.start(threadId, sandbox);
    if (entry.linger) clearTimeout(entry.linger);
    entry.linger = null;
    entry.holds += 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.drop(threadId, entry, sandbox);
    };
  }

  /** Stops keeping every VM awake, as OpenOrc closes. */
  close(): void {
    for (const entry of this.held.values()) {
      clearInterval(entry.timer);
      if (entry.linger) clearTimeout(entry.linger);
    }
    this.held.clear();
  }

  private start(threadId: string, sandbox: Sandbox): Held {
    let warned = false;
    const keep = () =>
      void sandbox.keepAwake().catch((error: unknown) => {
        // A plan's longest session ends it anyway; saying so once per hold is enough.
        if (warned) return;
        warned = true;
        this.options.log.warn(`cloud workspace of thread ${threadId} could not be kept awake: ${error instanceof Error ? error.message : String(error)}`);
      });
    keep();
    const timer = setInterval(keep, Math.min(KEEP_AWAKE_EVERY_MS, sandbox.awayMs / 4));
    timer.unref();
    const entry: Held = { holds: 0, timer, linger: null };
    this.held.set(threadId, entry);
    return entry;
  }

  private drop(threadId: string, entry: Held, sandbox: Sandbox): void {
    entry.holds -= 1;
    if (entry.holds > 0 || this.held.get(threadId) !== entry) return;
    entry.linger = setTimeout(
      () => {
        if (entry.holds > 0 || this.held.get(threadId) !== entry) return;
        clearInterval(entry.timer);
        this.held.delete(threadId);
        this.options.released(threadId);
      },
      Math.min(LINGER_MS, sandbox.awayMs / 4),
    );
    entry.linger.unref();
  }
}
