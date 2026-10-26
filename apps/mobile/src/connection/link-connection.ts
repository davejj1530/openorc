import type { ClientPush, CoreConnection } from "@openorc/client";
import type { MacMessage, PhoneSession } from "@openorc/link";
import type { AssetRef, DeviceMethod, DeviceParams, DeviceRpcResults, RemotePush, RpcMethod, RpcParams, RpcResults, SessionMethod, SessionParams, SessionRpcResults } from "@openorc/protocol";
import type { Clock } from "./route-race";

/** A watched Preview's newest state, or the end of the watch, which only its screen hears. */
export type PreviewPush = Extract<RemotePush, { type: "preview" | "preview.ended" }>;

/** What the phone needs of a session with a Mac: the link's own over the network, or the demo Mac's inside the app. */
export type PhoneLine = Pick<PhoneSession, "send" | "onMessage" | "onBytes" | "onClose" | "close" | "closed">;

/** What the Mac sends that the connection, not the session's owner, handles. */
export type CallMessage = Exclude<MacMessage, { t: "pong" | "closing" }>;

export interface Asset {
  mime: string;
  bytes: Uint8Array;
}

interface Pending {
  session: PhoneLine;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface Download {
  session: PhoneLine;
  mime: string;
  chunks: Uint8Array[];
  resolve(asset: Asset): void;
  reject(error: Error): void;
}

interface Waiter {
  ready(session: PhoneLine): void;
  fail(error: Error): void;
}

/** How long a call made while the phone connects waits for a session. */
export const CALL_WAIT_MS = 8_000;

export const DROPPED = "The connection to your Mac dropped before it answered.";
const NO_ANSWER = "Your Mac did not answer in time.";
const NO_MAC = "This phone is not connected to a Mac.";

function clientPush(push: RemotePush): ClientPush | null {
  switch (push.type) {
    case "frame":
      return push;
    case "invalidate":
      return push;
    case "notify": {
      const { type: _type, ...notice } = push;
      return { type: "notify", notice };
    }
    case "ready":
      return null;
    // A watched Preview's frames go to its own screen, never into the client's caches.
    case "preview":
    case "preview.ended":
      return null;
  }
}

/**
 * The phone's line to the core for `@openorc/client`, over whichever session is current. Calls made while the phone
 * connects wait for a session; a call in flight when its session drops fails and is never sent again, since the Mac
 * may already have acted on it. Every new session hears the phone's interest before anything else.
 */
export class LinkConnection implements CoreConnection {
  readonly delivery = "interest";
  private current: PhoneLine | null = null;
  private interest: string[] = [];
  private nextId = 0;
  private resumable = false;
  private readonly pending = new Map<number, Pending>();
  private readonly downloads = new Map<number, Download>();
  private readonly waiting = new Set<Waiter>();
  private readonly drains = new Map<PhoneLine, () => void>();
  private readonly listeners = new Set<(push: ClientPush) => void>();
  private readonly previews = new Set<(push: PreviewPush) => void>();

  constructor(
    private readonly clock: Clock,
    /** Whether a session may come: false while no Mac is paired, or the Mac cannot be talked to at all. */
    private readonly canWait: () => boolean,
  ) {}

  call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> {
    return this.rpc(method, params) as Promise<RpcResults[M]>;
  }

  /** A method about this phone itself, which the Mac's session answers for this phone alone. */
  device<M extends DeviceMethod>(method: M, params: DeviceParams<M>): Promise<DeviceRpcResults[M]> {
    return this.rpc(method, params) as Promise<DeviceRpcResults[M]>;
  }

  /** A method about this phone's current session, such as its one watch of a Preview, which ends with the session. */
  session<M extends SessionMethod>(method: M, params: SessionParams<M>): Promise<SessionRpcResults[M]> {
    return this.rpc(method, params) as Promise<SessionRpcResults[M]>;
  }

  /** The bytes behind an image the transcript names, or a watched Preview's frame. */
  asset(ref: AssetRef): Promise<Asset> {
    return this.withSession(
      (session) =>
        new Promise<Asset>((resolve, reject) => {
          const id = this.id();
          this.downloads.set(id, { session, mime: "", chunks: [], resolve, reject });
          session.send({ t: "asset", id, ref });
        }),
    );
  }

  onPush(listener: (push: ClientPush) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Hears the Preview pushes of the current session, which the Mac sends only while this phone watches. */
  onPreview(listener: (push: PreviewPush) => void): () => void {
    this.previews.add(listener);
    return () => this.previews.delete(listener);
  }

  setFrameInterest(runIds: ReadonlySet<string>): void {
    this.interest = [...runIds];
    this.current?.send({ t: "interest", runIds: this.interest });
  }

  /** Makes `session` the one calls go over. Calls in flight on an earlier session still get their answers there. */
  attach(session: PhoneLine): void {
    this.current = session;
    session.onClose(() => this.lost(session));
    session.send({ t: "interest", runIds: this.interest });
    this.emit({ type: "session", resumed: this.resumable });
    this.resumable = true;
    for (const waiter of this.waiting) waiter.ready(session);
    this.waiting.clear();
  }

  /**
   * For another Mac, or a client state cleared for one: nothing waiting carries over. `restored` says the client
   * already shows what an earlier session told it, so the first session counts as resumed.
   */
  reset(restored: boolean): void {
    this.resumable = restored;
    for (const waiter of this.waiting) waiter.fail(new Error(NO_MAC));
    this.waiting.clear();
  }

  receive(session: PhoneLine, message: CallMessage): void {
    switch (message.t) {
      case "rpc.result":
        this.settle(message.id)?.resolve(message.result);
        return;
      case "rpc.error":
        this.settle(message.id)?.reject(new Error(message.message));
        return;
      case "push": {
        if (session !== this.current) return;
        const pushed = message.push;
        if (pushed.type === "preview" || pushed.type === "preview.ended") for (const listener of this.previews) listener(pushed);
        const push = clientPush(pushed);
        if (push) this.emit(push);
        return;
      }
      case "gap":
        if (session === this.current) this.emit({ type: "gap", runIds: message.runIds });
        return;
      case "asset.bytes": {
        const download = this.downloads.get(message.id);
        if (download) download.mime = message.mime;
        return;
      }
      case "asset.error":
        this.settleDownload(message.id)?.reject(new Error(message.message));
        return;
    }
  }

  receiveBytes(stream: number, chunk: Uint8Array, end: boolean): void {
    const download = this.downloads.get(stream);
    if (!download) return;
    // A copy, as the chunk may be a view of a buffer the session reuses; made natively, as Uint8Array.from walks the
    // chunk byte by byte, which for a Preview frame twice a second was most of the app's JS garbage.
    download.chunks.push(chunk.slice());
    if (end) this.settleDownload(stream)?.resolve({ mime: download.mime, bytes: joined(download.chunks) });
  }

  /** Resolves once nothing asked over `session` waits for an answer: no call, and no image still downloading. */
  drained(session: PhoneLine): Promise<void> {
    return new Promise((done) => {
      this.drains.set(session, done);
      this.checkDrains();
    });
  }

  private rpc(method: string, params: unknown): Promise<unknown> {
    return this.withSession(
      (session) =>
        new Promise((resolve, reject) => {
          const id = this.id();
          this.pending.set(id, { session, resolve, reject });
          session.send({ t: "rpc", id, method, params });
        }),
    );
  }

  private withSession<T>(send: (session: PhoneLine) => Promise<T>): Promise<T> {
    if (this.current) return send(this.current);
    if (!this.canWait()) return Promise.reject(new Error(NO_MAC));
    return new Promise<PhoneLine>((ready, fail) => {
      const waiter: Waiter = {
        ready: (session) => {
          this.clock.clearTimeout(timer);
          ready(session);
        },
        fail: (error) => {
          this.clock.clearTimeout(timer);
          fail(error);
        },
      };
      const timer = this.clock.setTimeout(() => {
        this.waiting.delete(waiter);
        fail(new Error(NO_ANSWER));
      }, CALL_WAIT_MS);
      this.waiting.add(waiter);
    }).then(send);
  }

  private lost(session: PhoneLine): void {
    if (this.current === session) this.current = null;
    for (const [id, pending] of this.pending) {
      if (pending.session !== session) continue;
      this.pending.delete(id);
      pending.reject(new Error(DROPPED));
    }
    for (const [id, download] of this.downloads) {
      if (download.session !== session) continue;
      this.downloads.delete(id);
      download.reject(new Error(DROPPED));
    }
    this.checkDrains();
  }

  private settle(id: number): Pending | undefined {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    this.checkDrains();
    return pending;
  }

  private settleDownload(id: number): Download | undefined {
    const download = this.downloads.get(id);
    this.downloads.delete(id);
    this.checkDrains();
    return download;
  }

  private checkDrains(): void {
    for (const [session, done] of this.drains) {
      if ([...this.pending.values(), ...this.downloads.values()].some((asked) => asked.session === session)) continue;
      this.drains.delete(session);
      done();
    }
  }

  private id(): number {
    // Ids double as the u32 stream ids of asset bytes.
    this.nextId = (this.nextId % 0xffff_ffff) + 1;
    return this.nextId;
  }

  private emit(push: ClientPush): void {
    for (const listener of this.listeners) listener(push);
  }
}

function joined(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
