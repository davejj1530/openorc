import { PREVIEW_INPUT_WORDS, PREVIEW_TEXT_CHARS, type PreviewFocus, type PreviewInput } from "@openorc/protocol";

/** The page an input is for: the pane the shown frame is of, and that frame's size, which its points are in. */
export interface InputTarget {
  pane: string;
  frame: { width: number; height: number };
}
export interface QueuedInput {
  target: InputTarget;
  input: PreviewInput;
}

interface QueueDeps {
  send(item: QueuedInput): Promise<{ focus: PreviewFocus | null }>;
  /** The Mac's focus after `input` landed. */
  onFocus(focus: PreviewFocus | null, input: PreviewInput): void;
  /** Why the Mac refused, and whether to tell the person: a page that changed under a gesture says nothing. */
  onRefused(message: string, tell: boolean): void;
}

/** A drag sends at most one scroll per this long, the rest merged into it. */
const SCROLL_GAP_MS = 50;
const MAX_SCROLL = 20_000;
const clamp = (value: number) => Math.max(-MAX_SCROLL, Math.min(MAX_SCROLL, value));

/** One input standing for two in a row, or null when they must go apart. */
function merge(first: PreviewInput, next: PreviewInput): PreviewInput | null {
  if (first.kind === "scroll" && next.kind === "scroll") return { ...next, dx: clamp(first.dx + next.dx), dy: clamp(first.dy + next.dy) };
  if (first.kind === "text" && next.kind === "text" && first.text.length + next.text.length <= PREVIEW_TEXT_CHARS) return { kind: "text", text: first.text + next.text };
  if (first.kind === "key" && next.kind === "key" && first.key === "Backspace" && next.key === "Backspace" && first.count + next.count <= 100) return { ...first, count: first.count + next.count };
  return null;
}

const sameTarget = (a: InputTarget, b: InputTarget) => a.pane === b.pane && a.frame.width === b.frame.width && a.frame.height === b.frame.height;

/**
 * A phone's inputs to the Mac, one at a time and in order: what comes while one is out waits, a drag's scrolls and a
 * burst of typing merged, so a slow link sends fewer, larger inputs instead of a backlog, and the Mac's rate limit is
 * never met by a drag. A refusal drops what waits: it was aimed at a page that is not there any more.
 */
export class InputQueue {
  private waiting: QueuedInput[] = [];
  private busy = false;
  private lastScroll = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Counts clears, so an answer to an input sent before one changes nothing. */
  private generation = 0;

  constructor(private readonly deps: QueueDeps) {}

  push(target: InputTarget, input: PreviewInput): void {
    const last = this.waiting.at(-1);
    const merged = last && sameTarget(last.target, target) ? merge(last.input, input) : null;
    if (merged) this.waiting[this.waiting.length - 1] = { target, input: merged };
    else this.waiting.push({ target, input });
    this.pump();
  }

  clear(): void {
    this.waiting = [];
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private pump(): void {
    const next = this.waiting[0];
    if (this.busy || this.timer || !next) return;
    if (next.input.kind === "scroll") {
      const wait = this.lastScroll + SCROLL_GAP_MS - Date.now();
      if (wait > 0) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.pump();
        }, wait);
        return;
      }
      this.lastScroll = Date.now();
    }
    this.waiting.shift();
    this.busy = true;
    const generation = this.generation;
    this.deps
      .send(next)
      .then(
        ({ focus }) => generation === this.generation && this.deps.onFocus(focus, next.input),
        (error: Error) => {
          if (generation !== this.generation) return;
          this.waiting = [];
          this.deps.onRefused(error.message, error.message !== PREVIEW_INPUT_WORDS.pane);
        },
      )
      .finally(() => {
        this.busy = false;
        this.pump();
      });
  }
}
