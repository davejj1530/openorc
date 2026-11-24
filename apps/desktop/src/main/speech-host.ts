import type { DictationEvent, SpeechRequest } from "../shared/dictation";

/** The speech process as the host holds it; Electron's utility process fits, and a test hands in its own. */
export interface SpeechProcess {
  on(event: "message", listener: (message: unknown) => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
  postMessage(message: unknown): void;
  kill(): boolean;
}

/** How long the process outlives its last recording, with the model still loaded for the next one. */
const IDLE_MS = 5 * 60_000;

/**
 * The process that runs the speech model, as main holds it: started by the first recording, kept for the next, and
 * ended after a quiet while so the model's memory comes back. One recording runs at a time; a new one takes over. If
 * the process ends under a recording, the recording is told.
 */
export class SpeechHost {
  private child: SpeechProcess | null = null;
  private recording: string | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly fork: () => SpeechProcess,
    private readonly report: (event: DictationEvent) => void,
    private readonly idleMs = IDLE_MS,
  ) {}

  send(request: SpeechRequest): void {
    if (request.type === "start") this.begin(request.id);
    else if (request.id !== this.recording) return;
    this.child?.postMessage(request);
    if (request.type === "cancel") this.rest();
  }

  close(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.child?.kill();
    this.child = null;
    this.recording = null;
  }

  private begin(id: string): void {
    this.recording = id;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    if (this.child) return;
    const child = this.fork();
    this.child = child;
    child.on("message", (message) => {
      const event = message as DictationEvent;
      if (event.id === this.recording && event.type !== "words") this.rest();
      this.report(event);
    });
    child.once("exit", () => {
      if (this.child !== child) return;
      this.child = null;
      const cut = this.recording;
      this.recording = null;
      if (cut) this.report({ type: "failed", id: cut, reason: "Dictation stopped unexpectedly." });
    });
  }

  /** No recording is running: the process may end once it has been quiet long enough. */
  private rest(): void {
    this.recording = null;
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), this.idleMs);
  }
}
