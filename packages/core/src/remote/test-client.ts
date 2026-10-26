import { connectLink, decodePairingUrl, toBase64Url, type ClosingReason, type KeyPair, type MacMessage, type PhoneSession, type Refusal } from "@openorc/link";
import { nodeCrypto } from "@openorc/link/node";
import type { AssetRef, DeviceMethod, DeviceParams, DeviceRpcResults, RemotePush, Route, RpcMethod, RpcParams, RpcResults, SessionMethod, SessionParams, SessionRpcResults } from "@openorc/protocol";
import { WebSocket } from "ws";
import { LINK_PATH } from "./listener.js";
import { linkSocket } from "./ws-socket.js";

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface AssetDownload {
  mime: string;
  chunks: Uint8Array[];
  resolve(asset: { mime: string; bytes: Uint8Array }): void;
  reject(error: Error): void;
}

function openSocket(route: Route): Promise<WebSocket> {
  const host = route.host.includes(":") ? `[${route.host}]` : route.host;
  const ws = new WebSocket(`ws://${host}:${route.port}${LINK_PATH}`);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

/**
 * A phone for tests: a real WebSocket over loopback, the real Noise handshake, and the messages the app sends.
 * `connect` resolves to the client, or to why the Mac declined it.
 */
export class RemoteTestClient {
  readonly pushes: RemotePush[] = [];
  readonly gaps: string[][] = [];
  closing: ClosingReason | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly downloads = new Map<number, AssetDownload>();

  private constructor(
    private readonly session: PhoneSession,
    readonly deviceId: string,
    /** The phone's static pair: what the Mac knows it by, and what its alerts are sealed for. */
    readonly keys: KeyPair,
  ) {
    session.onMessage((message) => this.receive(message));
    session.onBytes((stream, chunk, end) => {
      const download = this.downloads.get(stream);
      if (!download) return;
      download.chunks.push(Uint8Array.from(chunk));
      if (!end) return;
      this.downloads.delete(stream);
      download.resolve({ mime: download.mime, bytes: Uint8Array.from(Buffer.concat(download.chunks)) });
    });
  }

  static async connect(options: { route: Route; macKey: Uint8Array; device?: KeyPair; name?: string; pair?: { offerId: string; secret: Uint8Array } }): Promise<RemoteTestClient | Refusal> {
    const device = options.device ?? nodeCrypto.generateKeyPair();
    const pair = options.pair && { offerId: options.pair.offerId, secret: toBase64Url(options.pair.secret) };
    const result = await connectLink({
      socket: linkSocket(await openSocket(options.route)),
      crypto: nodeCrypto,
      device,
      macKey: options.macKey,
      hello: { device: { name: options.name ?? "Test phone" }, ...(pair ? { pair } : {}) },
      timeoutMs: 5_000,
    });
    if (result.ok) return new RemoteTestClient(result.session, result.hello.deviceId, device);
    if (result.refused) return result.refused;
    throw new Error(result.error);
  }

  /** Scans a pairing code and connects over its first route. */
  static async pair(url: string, options: { device?: KeyPair; name?: string } = {}): Promise<RemoteTestClient | Refusal> {
    const offer = decodePairingUrl(url);
    return RemoteTestClient.connect({ ...options, route: offer.routes[0]!, macKey: offer.macKey, pair: { offerId: offer.offerId, secret: offer.secret } });
  }

  get closed(): boolean {
    return this.session.closed;
  }

  call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> {
    return this.request(method, params) as Promise<RpcResults[M]>;
  }

  /** A method about this phone itself, as LinkConnection.device sends it. */
  device<M extends DeviceMethod>(method: M, params: DeviceParams<M>): Promise<DeviceRpcResults[M]> {
    return this.request(method, params) as Promise<DeviceRpcResults[M]>;
  }

  /** A method about this session itself, such as its watch of a Preview. */
  sessionMethod<M extends SessionMethod>(method: M, params: SessionParams<M>): Promise<SessionRpcResults[M]> {
    return this.request(method, params) as Promise<SessionRpcResults[M]>;
  }

  /** Any method name at all, as a hostile phone would send it. */
  request(method: string, params?: unknown): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.session.send({ t: "rpc", id, method, params });
    });
  }

  interest(runIds: string[]): void {
    this.session.send({ t: "interest", runIds });
  }

  asset(ref: AssetRef): Promise<{ mime: string; bytes: Uint8Array }> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.downloads.set(id, { mime: "", chunks: [], resolve, reject });
      this.session.send({ t: "asset", id, ref });
    });
  }

  /** Resolves once `predicate` holds, checking every few milliseconds. */
  async until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
    const started = Date.now();
    while (!predicate()) {
      if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for the phone");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  close(): void {
    this.session.close(1000, "");
  }

  private receive(message: MacMessage): void {
    switch (message.t) {
      case "rpc.result":
        this.settle(message.id, (pending) => pending.resolve(message.result));
        return;
      case "rpc.error":
        this.settle(message.id, (pending) => pending.reject(new Error(message.message)));
        return;
      case "push":
        this.pushes.push(message.push);
        return;
      case "gap":
        this.gaps.push(message.runIds);
        return;
      case "asset.bytes": {
        const download = this.downloads.get(message.id);
        if (download) download.mime = message.mime;
        return;
      }
      case "asset.error":
        this.downloads.get(message.id)?.reject(new Error(message.message));
        this.downloads.delete(message.id);
        return;
      case "pong":
        return;
      case "closing":
        this.closing = message.reason;
        return;
    }
  }

  private settle(id: number, finish: (pending: Pending) => void): void {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    if (pending) finish(pending);
  }
}
