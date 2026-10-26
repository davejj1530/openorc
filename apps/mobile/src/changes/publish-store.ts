import type { Lost, Publishing } from "./publish-state";

interface KeyValue {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface PublishStoreDeps {
  storage: KeyValue;
  macId: () => string | null;
  /** Whether a write's error says the link dropped before the Mac answered. */
  dropped: (error: Error) => boolean;
  haptic: { confirm: () => void; fail: () => void };
  now: () => number;
}

const IDLE: Publishing = { kind: "idle" };
const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

/**
 * Each thread's commit, push and pull request as they run, shared by the Changes screen and its sheets. A write out is
 * kept in the phone's storage until it answers, so one lost with the link, or with the app, is settled from reads
 * after a relaunch too, and never sent again.
 */
export function createPublishStore({ storage, macId, dropped, haptic, now }: PublishStoreDeps) {
  const states = new Map<string, Publishing>();
  const lostAt = new Map<string, number>();
  const listeners = new Set<() => void>();
  const keyOf = (threadId: string) => `publish.${macId() ?? "none"}.${threadId}`;

  function set(threadId: string, state: Publishing): void {
    states.set(threadId, state);
    listeners.forEach((listener) => listener());
  }

  function saved(threadId: string): Lost | null {
    try {
      const text = storage.getString(keyOf(threadId));
      return text ? (JSON.parse(text) as Lost) : null;
    } catch {
      return null;
    }
  }

  function get(threadId: string): Publishing {
    const state = states.get(threadId);
    if (state) return state;
    const lost = saved(threadId);
    if (!lost) return IDLE;
    const found: Publishing = { kind: "lost", lost };
    states.set(threadId, found);
    // Kept from before this app started: it was lost with the app, and every read this app holds came after.
    lostAt.set(threadId, 0);
    return found;
  }

  function lose(threadId: string, lost: Lost): void {
    lostAt.set(threadId, now());
    set(threadId, { kind: "lost", lost });
  }

  return {
    get,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** When the write went unanswered; reads made after this can settle it. */
    lostAt: (threadId: string): number => lostAt.get(threadId) ?? 0,
    /** Runs one write unless another is out for the thread. Resolves with its result, or null when it did not answer. */
    async run<T>(threadId: string, lost: Lost, write: () => Promise<T>, notice: (result: T) => string): Promise<T | null> {
      const current = get(threadId).kind;
      if (current === "running" || current === "lost") return null;
      storage.set(keyOf(threadId), JSON.stringify(lost));
      set(threadId, { kind: "running", action: lost.action });
      try {
        const result = await write();
        storage.remove(keyOf(threadId));
        haptic.confirm();
        set(threadId, { kind: "notice", action: lost.action, text: notice(result), tone: "muted", details: null });
        return result;
      } catch (thrown) {
        const error = asError(thrown);
        if (dropped(error)) {
          lose(threadId, lost);
          return null;
        }
        storage.remove(keyOf(threadId));
        haptic.fail();
        set(threadId, { kind: "notice", action: lost.action, text: error.message, tone: "bad", details: error.message });
        return null;
      }
    },
    /** What fresh reads say a lost write did. */
    settle(threadId: string, outcome: { kind: "done"; notice: string } | { kind: "not-done" }): void {
      const state = get(threadId);
      if (state.kind !== "lost") return;
      storage.remove(keyOf(threadId));
      if (outcome.kind === "not-done") return set(threadId, IDLE);
      haptic.confirm();
      set(threadId, { kind: "notice", action: state.lost.action, text: outcome.notice, tone: "muted", details: null });
    },
    clear(threadId: string): void {
      const kind = get(threadId).kind;
      if (kind === "notice") set(threadId, IDLE);
    },
    /** Lets go of every write held in memory, as a fresh install has; a write kept in storage is still read back. */
    reset(): void {
      states.clear();
      lostAt.clear();
      listeners.forEach((listener) => listener());
    },
  };
}

export type PublishStore = ReturnType<typeof createPublishStore>;
