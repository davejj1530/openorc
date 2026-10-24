import { LinkCloseCode, type ClosingReason, type MacMessage, type MacSession, type PhoneMessage } from "@openorc/link";
import type { AssetRef, RemotePush, RpcRequest } from "@openorc/protocol";
import type { ImageFileRead } from "../services/profile-assets.js";
import type { RpcReply } from "../transport.js";
import { admitRemoteRequest, type GuardContext } from "./policy.js";

/** The request path the windows use: counted while in flight and refused while the app restarts. */
export type Answer = (request: RpcRequest) => Promise<RpcReply>;

const BATCH_MS = 50;
/** A phone sends at least a ping more often than this; a session that hears nothing for this long ends. */
const IDLE_MS = 45_000;
/** Frames are dropped while this much waits for a phone, and reported as a gap once it drains below the second. */
const SHED_ABOVE = 2 * 1024 * 1024;
const DRAINED_BELOW = 256 * 1024;
/** Each image is held whole in memory until its last chunk is sent. */
const MAX_ASSET_STREAMS = 4;

export interface SessionDeps {
  answer: Answer;
  guard: GuardContext;
  readAsset(ref: AssetRef): Promise<ImageFileRead>;
}

/**
 * One connected phone. Pushes wait up to 50 ms and leave together, and frames go only for runs the phone asked
 * for. A phone that falls behind loses frames instead of the Mac holding megabytes for it, then hears which runs to
 * reload. A reply leaves after every push queued before it, so it never overtakes a frame made before the answer.
 */
export class RemoteSession {
  private interest: ReadonlySet<string> = new Set();
  private queue: MacMessage[] = [];
  private queuedBytes = 0;
  private readonly shed = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private streaming = 0;
  private heardFrom = false;
  private readonly idle: ReturnType<typeof setTimeout>;
  /**
   * Settles true on the phone's first record and false if the session ends before one. Until then the handshake may
   * be a replayed message from someone who cannot read the answer.
   */
  readonly firstRecord: Promise<boolean>;

  constructor(
    readonly deviceId: string,
    private readonly link: MacSession,
    private readonly deps: SessionDeps,
  ) {
    let heard!: (value: boolean) => void;
    this.firstRecord = new Promise((resolve) => (heard = resolve));
    this.idle = setTimeout(() => link.close(LinkCloseCode.timeout, "idle"), IDLE_MS);
    link.onMessage((message) => {
      this.idle.refresh();
      this.heardFrom = true;
      heard(true);
      this.receive(message);
    });
    link.onClose(() => {
      clearTimeout(this.idle);
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      heard(false);
    });
  }

  get closed(): boolean {
    return this.link.closed;
  }

  /** Whether the phone has sent anything over this session. */
  get live(): boolean {
    return this.heardFrom;
  }

  wants(runId: string): boolean {
    return this.interest.has(runId);
  }

  onClose(listener: () => void): void {
    this.link.onClose(listener);
  }

  /** One push; a frame comes shaped, with its size. */
  push(push: RemotePush, bytes = 0): void {
    if (this.link.closed) return;
    if (push.type === "frame") {
      const { runId } = push.frame;
      if (!this.interest.has(runId) || this.shed.has(runId)) return;
      if (this.link.bufferedAmount() + this.queuedBytes + bytes > SHED_ABOVE) {
        this.shed.add(runId);
        this.schedule();
        return;
      }
    }
    this.queue.push({ t: "push", push });
    this.queuedBytes += bytes;
    this.schedule();
  }

  /** Tells the phone why, then ends the session. */
  close(reason: ClosingReason): void {
    if (this.link.closed) return;
    this.flush();
    this.link.send({ t: "closing", reason });
    this.link.close(LinkCloseCode.closing, reason);
  }

  private schedule(): void {
    this.timer ??= setTimeout(() => this.tick(), BATCH_MS);
  }

  private tick(): void {
    this.timer = null;
    this.flush();
    if (this.shed.size === 0) return;
    if (this.link.bufferedAmount() >= DRAINED_BELOW) {
      this.schedule();
      return;
    }
    this.link.send({ t: "gap", runIds: [...this.shed] });
    this.shed.clear();
  }

  private flush(): void {
    for (const message of this.queue) this.link.send(message);
    this.queue = [];
    this.queuedBytes = 0;
  }

  private receive(message: PhoneMessage): void {
    switch (message.t) {
      case "rpc":
        void this.call(message.id, message.method, message.params);
        return;
      case "interest":
        this.interest = new Set(message.runIds);
        for (const runId of this.shed) if (!this.interest.has(runId)) this.shed.delete(runId);
        return;
      case "asset":
        void this.asset(message.id, message.ref);
        return;
      case "ping":
        this.link.send({ t: "pong", id: message.id });
        return;
    }
  }

  private async call(id: number, method: string, params: unknown): Promise<void> {
    const admission = admitRemoteRequest(method, params, this.deps.guard);
    const reply: RpcReply = admission.ok
      ? await this.deps.answer({ type: "rpc", id, method, params }).catch((error: unknown): RpcReply => ({ type: "rpc.error", id, message: error instanceof Error ? error.message : String(error) }))
      : { type: "rpc.error", id, message: admission.message };
    if (this.link.closed) return;
    this.flush();
    this.link.send(reply.type === "rpc.result" ? { t: "rpc.result", id, result: reply.result } : { t: "rpc.error", id, message: reply.message });
  }

  private async asset(id: number, ref: AssetRef): Promise<void> {
    if (this.streaming >= MAX_ASSET_STREAMS) {
      this.link.send({ t: "asset.error", id, message: "Too many images at once." });
      return;
    }
    this.streaming++;
    try {
      const read = await this.deps.readAsset(ref).catch((): ImageFileRead => ({ ok: false, reason: "missing" }));
      if (this.link.closed) return;
      if (!read.ok) {
        this.link.send({ t: "asset.error", id, message: "This image is not available." });
        return;
      }
      this.link.send({ t: "asset.bytes", id, mime: read.mime, size: read.bytes.length });
      await this.link.sendBytes(id, read.bytes);
    } finally {
      this.streaming--;
    }
  }
}
