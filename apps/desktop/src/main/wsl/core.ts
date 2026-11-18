import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { encodeFrame, FrameReader, type WslFrame } from "../../shared/wsl-frames";

/** Main's end of one window's channel, as this file uses it: a MessagePortMain in the app. */
export interface WindowChannel {
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
}

/** The core's process as this file uses it: wsl.exe with the core behind it. */
export interface CoreChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Its end, once everything it wrote has been read: a frame it sent last is never lost to its exit. */
  once(event: "close", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  kill(): boolean;
}

export interface WslCoreStart {
  child: CoreChild;
  /** The first frame, which tells the core where its profile is and gives it the file key. */
  start: Extract<WslFrame, { t: "start" }>;
}

/** How many of the core's last printed lines are kept to explain a stop. */
const KEPT_LINES = 12;

/**
 * The core inside a WSL distribution, in the shape main knows a core by: messages on its private channel, an exit, and
 * windows handed to it. A utility process is given each window's port and talks to it directly; this core is on the
 * other side of wsl.exe's pipes, so main keeps the ports and relays every message as a frame.
 *
 * It exists from the moment the distribution is chosen, before anything is installed there or started: what main and
 * the windows send meanwhile is kept and sent in order once the core is up, and the windows are told what it waits on.
 */
export class WslCore extends EventEmitter {
  private readonly windows = new Map<number, WindowChannel>();
  private nextWindow = 1;
  private child: CoreChild | null = null;
  /** Frames for a core that has not started yet; null once it has. */
  private waiting: WslFrame[] | null = [];
  /** What the windows are told the core waits on, until its own startup takes over. */
  private status: string | null = null;
  private ended = false;
  /** Ends the preparation when the core is ended before it started: nothing goes on installing for nobody. */
  private readonly preparing = new AbortController();
  /** The last lines the core printed, for whoever has to say why it stopped. */
  private readonly printed: string[] = [];

  /**
   * `prepare` makes the distribution ready and starts the core there, saying what it is doing as it goes, and stops
   * when its signal says the core was ended meanwhile. A failure is reported through `failed` in its own words, then as
   * an exit like any other.
   */
  constructor(prepare: (progress: (text: string) => void, signal: AbortSignal) => Promise<WslCoreStart>, log: (line: string) => void = (line) => process.stderr.write(`${line}\n`)) {
    super();
    this.log = log;
    prepare((text) => this.tell(text), this.preparing.signal).then(
      (started) => this.started(started),
      (error: unknown) => {
        if (this.ended) return;
        this.emit("failed", error instanceof Error ? error : new Error(String(error)));
        this.end(1);
      },
    );
  }

  private readonly log: (line: string) => void;

  /** True until the core has started inside the distribution: nothing runs there yet that ending it could cut short. */
  get starting(): boolean {
    return !this.ended && this.waiting !== null;
  }

  /** The end of what the core printed, a few lines of it: why it stopped, when it stopped by itself. */
  get lastWords(): string {
    return this.printed.join("\n");
  }

  /** To the core, on the private channel. */
  postMessage(message: unknown): void {
    this.send({ t: "host", data: message });
  }

  /** Hands the core one window. Device video has nowhere to come from inside a distribution, so its port closes. */
  connect(rpc: WindowChannel, media?: { close(): void }): void {
    media?.close();
    if (this.ended) return rpc.close();
    const window = this.nextWindow++;
    this.windows.set(window, rpc);
    this.send({ t: "open", window });
    rpc.on("message", (event) => this.send({ t: "rpc", window, data: event.data }));
    rpc.on("close", () => {
      if (this.windows.delete(window)) this.send({ t: "close", window });
    });
    rpc.start();
    if (this.status) rpc.postMessage({ type: "startup", message: this.status });
  }

  /** Ends the core. Closing its input is what it reads as the app leaving, so it closes its ledger before it goes. */
  kill(): boolean {
    if (this.ended) return false;
    if (!this.child) {
      this.end(1);
      return true;
    }
    this.child.stdin.end();
    return this.child.kill();
  }

  private tell(text: string): void {
    if (this.ended || !this.waiting) return;
    this.status = text;
    for (const window of this.windows.values()) window.postMessage({ type: "startup", message: text });
  }

  private send(frame: WslFrame): void {
    if (this.ended) return;
    if (this.waiting) this.waiting.push(frame);
    else this.write(frame);
  }

  private write(frame: WslFrame): void {
    const stdin = this.child?.stdin;
    if (stdin && !stdin.destroyed && !stdin.writableEnded) stdin.write(encodeFrame(frame));
  }

  private started({ child, start }: WslCoreStart): void {
    if (this.ended) {
      // Ended while the distribution was being made ready: the core that just started has nobody to serve.
      child.stdin.end();
      child.kill();
      return;
    }
    this.child = child;
    const reader = new FrameReader(
      (frame) => this.receive(frame),
      (line) => this.print(line),
    );
    child.stdout.on("data", (chunk: Buffer) => reader.push(chunk));
    child.stdout.on("end", () => reader.end());
    let rest = "";
    child.stderr.on("data", (chunk: Buffer) => {
      const lines = (rest + chunk.toString("utf8")).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) this.print(line);
    });
    child.stdin.on("error", () => undefined);
    child.once("error", (error) => {
      this.emit("failed", error);
      this.end(1);
    });
    child.once("close", (code) => this.end(code ?? 1));
    const waiting = this.waiting ?? [];
    this.waiting = null;
    this.status = null;
    this.write(start);
    for (const frame of waiting) this.write(frame);
  }

  private print(line: string): void {
    this.log(`[core] ${line}`);
    if (!line.trim()) return;
    this.printed.push(line.slice(0, 300));
    if (this.printed.length > KEPT_LINES) this.printed.shift();
  }

  private receive(frame: WslFrame): void {
    if (frame.t === "host") this.emit("message", frame.data);
    else if (frame.t === "rpc") this.windows.get(frame.window)?.postMessage(frame.data);
  }

  private end(code: number): void {
    if (this.ended) return;
    this.ended = true;
    this.preparing.abort();
    const windows = [...this.windows.values()];
    this.windows.clear();
    for (const window of windows) window.close();
    this.emit("exit", code);
  }
}
