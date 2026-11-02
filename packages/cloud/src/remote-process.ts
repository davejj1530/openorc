import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { OutputStream, ProcessExit } from "./runner/wire.js";

export interface PendingInput {
  at: number;
  data: Buffer;
  done: (error?: Error | null) => void;
}

export interface RemoteCommand {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** How a remote process reaches its runner. Each call is a no-op while disconnected; the reconnect resends. */
export interface RemoteProcessLink {
  sendInput(id: string, input: PendingInput): void;
  endInput(id: string, at: number): void;
  signal(id: string, signal: string): void;
}

function drained(stream: PassThrough): Promise<void> {
  return new Promise((resolve) => {
    if (stream.readableEnded) return resolve();
    stream.once("end", resolve);
    stream.once("close", resolve);
    // Output nobody reads would otherwise hold the close back forever.
    if (stream.readableFlowing === null) stream.resume();
  });
}

/**
 * An agent process in a cloud workspace, shaped like a local child process so a provider adapter drives it the same
 * way. It has no pid, so local process-group handling passes over it and `kill` travels to the runner instead.
 * Input is acknowledged by the runner before a write completes, so nothing is lost across a reconnect.
 */
export class RemoteProcess extends EventEmitter {
  readonly pid = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  /** Output bytes received per stream: where a reattach resumes. */
  readonly received: Record<OutputStream, number> = { stdout: 0, stderr: 0 };
  /** Input the runner has not acknowledged, oldest first. */
  readonly unacked: PendingInput[] = [];
  /** Where input ends, once the adapter closes stdin. */
  inputEnd: number | null = null;
  private written = 0;
  private started = false;
  private exit: ProcessExit | null = null;

  constructor(
    readonly id: string,
    readonly command: RemoteCommand,
    private readonly link: RemoteProcessLink,
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        if (this.exit) return done(new Error("The process has exited."));
        const input = { at: this.written, data: chunk, done };
        this.written += chunk.length;
        this.unacked.push(input);
        link.sendInput(id, input);
      },
      final: (done) => {
        this.inputEnd = this.written;
        link.endInput(id, this.written);
        done();
      },
    });
  }

  get exited(): boolean {
    return this.exit !== null;
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.exit) return false;
    this.link.signal(this.id, typeof signal === "string" ? signal : "SIGTERM");
    return true;
  }

  acknowledge(at: number): void {
    while (this.unacked[0] && this.unacked[0].at + this.unacked[0].data.length <= at) this.unacked.shift()?.done();
  }

  /** Output already received is dropped, so a replay after a reconnect is never delivered twice. */
  receive(stream: OutputStream, at: number, data: Buffer): void {
    const have = this.received[stream];
    if (at > have) return;
    const fresh = data.subarray(have - at);
    if (fresh.length === 0) return;
    this.received[stream] += fresh.length;
    this[stream].write(fresh);
  }

  markStarted(): void {
    if (this.started) return;
    this.started = true;
    this.emit("spawn");
  }

  finish(exit: ProcessExit): void {
    if (this.exit) return;
    this.exit = exit;
    this.exitCode = exit.code;
    this.signalCode = (exit.signal ?? (exit.lost ? "SIGKILL" : null)) as NodeJS.Signals | null;
    for (const input of this.unacked.splice(0)) input.done(new Error("The process has exited."));
    if (exit.error && this.listenerCount("error") > 0) this.emit("error", new Error(exit.error));
    this.emit("exit", this.exitCode, this.signalCode);
    this.stdout.end();
    this.stderr.end();
    void Promise.all([drained(this.stdout), drained(this.stderr)]).then(() => this.emit("close", this.exitCode, this.signalCode));
  }
}
