import { Refused } from "./session.js";

/** The server's code for a start under a family that already has as many subthreads as it takes. */
const FULL = "subthreads_full";

/**
 * The families the server said are full, in its words, each with how many subthreads it had then. New subthread is held
 * in those words until one of them goes; how many a family takes is the server's alone to say.
 */
export class SubthreadLimit {
  readonly #full = new Map<string, { words: string; count: number }>();

  /** Whether `error` is the server saying the family under `root`, with `count` subthreads, is full; kept if so. */
  note(error: unknown, root: string, count: number): boolean {
    if (!(error instanceof Refused) || error.code !== FULL) return false;
    this.#full.set(root, { words: error.message, count });
    return true;
  }

  /** The server's words while the family has as many subthreads as when it refused; null once one has gone. */
  held(root: string, count: number): string | null {
    const full = this.#full.get(root);
    if (!full) return null;
    if (count >= full.count) return full.words;
    this.#full.delete(root);
    return null;
  }
}
