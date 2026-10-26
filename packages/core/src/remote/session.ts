import { LinkCloseCode, type ClosingReason, type MacMessage, type MacSession, type PhoneMessage } from "@openorc/link";
import {
  deviceRpcParams,
  isDeviceMethod,
  isRemoteMethod,
  isSessionMethod,
  sessionRpcParams,
  type AssetRef,
  type DeviceMethod,
  type DeviceParams,
  type RemotePush,
  type RpcRequest,
  type SessionMethod,
  type SessionParams,
} from "@openorc/protocol";
import { invalidParamsMessage } from "../handlers/diagnostics.js";
import type { RequestOrigin } from "../request-origin.js";
import { PREVIEW_THREAD_GONE } from "../services/preview.js";
import type { ImageFileRead } from "../services/profile-assets.js";
import type { RpcReply } from "../transport.js";
import { remoteError, type MacRoots } from "./phone-words.js";
import { admitRemoteRequest, remoteReply, type GuardContext } from "./policy.js";
import type { PreviewCasters } from "./preview-casters.js";

/** The request path the windows use: counted while in flight and refused while the app restarts. A phone's request names its origin. */
export type Answer = (request: RpcRequest, origin?: RequestOrigin) => Promise<RpcReply>;

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
  /** The Mac's folders as they are now, which no error or reason a phone hears may name. */
  roots(): MacRoots;
  readAsset(ref: AssetRef): Promise<ImageFileRead>;
  /** A method about the calling phone itself, for the session's own device. */
  device(deviceId: string, method: DeviceMethod, params: DeviceParams<DeviceMethod>): Promise<unknown>;
  /** The Mac's Preview, watched per session. Null on a Mac without one: a watch reads as closed, no frame is served. */
  preview: Pick<PreviewCasters, "watch" | "unwatch" | "frame"> | null;
  /** Whether a thread's Preview may be watched: the thread exists and no team deletion hid it. */
  watchable(threadId: string): boolean;
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
      deps.preview?.unwatch(this);
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

  /** Hook output and Git's stderr can hold a token, and Git names the Mac's folders. */
  private readonly words = (message: string): string => remoteError(message, this.deps.roots());

  /** Every error passes remoteError. */
  private async call(id: number, method: string, params: unknown): Promise<void> {
    const reply = await this.reply(id, method, params).catch((error: unknown): RpcReply => ({ type: "rpc.error", id, message: error instanceof Error ? error.message : String(error) }));
    if (this.link.closed) return;
    this.flush();
    this.link.send(reply.type === "rpc.result" ? { t: "rpc.result", id, result: reply.result } : { t: "rpc.error", id, message: this.words(reply.message) });
  }

  /** A method about this phone is answered for its own device id, so it can never name another; the rest goes to the core. */
  private async reply(id: number, method: string, params: unknown): Promise<RpcReply> {
    if (isDeviceMethod(method)) {
      const parsed = deviceRpcParams[method].safeParse(params ?? {});
      if (!parsed.success) return { type: "rpc.error", id, message: invalidParamsMessage(method, parsed.error.message) };
      return { type: "rpc.result", id, result: await this.deps.device(this.deviceId, method, parsed.data) };
    }
    if (isSessionMethod(method)) return this.ownSession(id, method, params);
    const admission = admitRemoteRequest(method, params, this.deps.guard);
    if (!admission.ok || !isRemoteMethod(method)) return { type: "rpc.error", id, message: admission.ok ? "This is not available from a phone." : admission.message };
    const reply = await this.deps.answer({ type: "rpc", id, method, params }, { kind: "phone", deviceId: this.deviceId });
    return reply.type === "rpc.result" ? { ...reply, result: remoteReply(method, reply.result as never, { words: this.words, roots: this.deps.roots }) } : reply;
  }

  /** A method about this session itself: its one watch of a thread's Preview. */
  private async ownSession(id: number, method: SessionMethod, params: unknown): Promise<RpcReply> {
    const parsed = sessionRpcParams[method].safeParse(params ?? {});
    if (!parsed.success) return { type: "rpc.error", id, message: invalidParamsMessage(method, parsed.error.message) };
    if (method === "preview.unwatch") {
      this.deps.preview?.unwatch(this);
      return { type: "rpc.result", id, result: null };
    }
    const watch = parsed.data as SessionParams<"preview.watch">;
    if (!this.deps.watchable(watch.threadId)) return { type: "rpc.error", id, message: PREVIEW_THREAD_GONE };
    return { type: "rpc.result", id, result: this.deps.preview ? await this.deps.preview.watch(this, watch) : { open: false } };
  }

  /** The newest frame of the Preview this session watches. Never through readAsset: frames are not files. */
  private preview(id: number, ref: Extract<AssetRef, { kind: "preview" }>): Promise<void> {
    const bytes = this.deps.preview?.frame(this, ref.threadId, ref.seq) ?? null;
    if (!bytes) {
      this.link.send({ t: "asset.error", id, message: "This page is not being watched." });
      return Promise.resolve();
    }
    this.link.send({ t: "asset.bytes", id, mime: "image/jpeg", size: bytes.length });
    return this.link.sendBytes(id, bytes);
  }

  private async asset(id: number, ref: AssetRef): Promise<void> {
    if (this.streaming >= MAX_ASSET_STREAMS) {
      this.link.send({ t: "asset.error", id, message: "Too many images at once." });
      return;
    }
    this.streaming++;
    try {
      if (ref.kind === "preview") return await this.preview(id, ref);
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
