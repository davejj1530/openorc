import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import type { Broadcast, RpcReply } from "@openorc/core";
import { encodeFrame, FrameReader, type WslFrame } from "../../shared/wsl-frames";
import type { WindowPort } from "../reply";

/** The core's end of one window's channel when the window is on the Windows side: its messages are frames under its number. */
class FramedWindow extends EventEmitter implements WindowPort {
  constructor(
    private readonly id: number,
    private readonly send: (frame: WslFrame) => void,
  ) {
    super();
  }

  postMessage(message: Broadcast | RpcReply): void {
    this.send({ t: "rpc", window: this.id, data: message });
  }
}

export interface FrameChannelHandlers {
  /** The first frame main wrote. Nothing else is read as anything before it. */
  start(frame: Extract<WslFrame, { t: "start" }>): void;
  /** A message on the private channel. */
  host(message: unknown): void;
  /** A window connected. */
  window(port: WindowPort): void;
  /** Main closed its end: the app quit, or wsl.exe was ended under it. */
  ended(): void;
  /** A line that is no frame. */
  noise?(line: string): void;
}

/**
 * The core's side of the pipes wsl.exe gives it: frames in on `input`, frames out on `output`. Windows exist here only
 * as numbers main chose, each given the shape of a port so the core serves it like any other.
 */
export class FrameChannel {
  private readonly windows = new Map<number, FramedWindow>();
  private started = false;
  private ended = false;

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly handlers: FrameChannelHandlers,
  ) {
    const reader = new FrameReader(
      (frame) => this.receive(frame),
      (line) => handlers.noise?.(line),
    );
    input.on("data", (chunk: Buffer) => reader.push(chunk));
    input.on("end", () => {
      reader.end();
      this.end();
    });
    input.on("error", () => this.end());
    // A pipe whose reader left: there is nobody to write to, and nothing more will be asked.
    output.on("error", () => this.end());
  }

  /** To main, on the private channel. */
  readonly post = (message: unknown): void => this.send({ t: "host", data: message });

  /** Ends the output once every frame written has left, then calls `done`. */
  close(done: () => void): void {
    if (this.output.destroyed || this.output.writableEnded) return done();
    this.output.end(done);
  }

  private send(frame: WslFrame): void {
    if (this.ended || this.output.destroyed || this.output.writableEnded) return;
    this.output.write(encodeFrame(frame));
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const window of this.windows.values()) window.emit("close");
    this.windows.clear();
    this.handlers.ended();
  }

  private receive(frame: WslFrame): void {
    if (frame.t === "start") {
      if (this.started) return;
      this.started = true;
      this.handlers.start(frame);
      return;
    }
    if (!this.started) return;
    switch (frame.t) {
      case "host":
        return this.handlers.host(frame.data);
      case "open": {
        if (this.windows.has(frame.window)) return;
        const window = new FramedWindow(frame.window, (reply) => this.send(reply));
        this.windows.set(frame.window, window);
        return this.handlers.window(window);
      }
      case "close":
        this.windows.get(frame.window)?.emit("close");
        this.windows.delete(frame.window);
        return;
      case "rpc":
        this.windows.get(frame.window)?.emit("message", { data: frame.data });
    }
  }
}
