import { connectLink, type KeyPair, type LinkSocket, type MacMessage, type PhoneSession } from "@openorc/link";
import { nodeCrypto } from "@openorc/link/node";
import { PHONE_CAPABILITIES, type OwnerReach, type RemotePush, type RpcMethod, type RpcParams, type RpcResults } from "@openorc/protocol";
import { WebSocket } from "ws";
import type { Logger } from "../transport.js";
import { linkSocket } from "../remote/ws-socket.js";

/** Where the Mac dials its brain, with the keys of both ends. */
export interface BrainTarget {
  url: string;
  brainKey: Uint8Array;
  ownerKeys: KeyPair;
}

/** Mac project ids and the brain's copies of them. */
export interface ProjectMapping {
  toCloud(macProject: string): string | null;
  toMac(cloudProject: string): string | null;
  /** Every Mac project the brain has a copy of, with its copy. */
  pairs?: readonly { mac: string; cloud: string }[];
}

/** The Mac's cloud brain as its windows need it. */
export interface BrainEndpoint {
  /** A brain is set up. Never wakes it. */
  ready(): Promise<boolean>;
  /** Null before the Mac has learned how to dial it. Never wakes it. */
  locate(): Promise<BrainTarget | null>;
  /** Wakes the brain for a window's own intent, as Wake does; resolves once it runs. */
  wake(): Promise<void>;
  projects(): Promise<ProjectMapping>;
  /** Sends the brain what is new on this Mac's chosen branches, while it runs. Never wakes it. */
  freshen?(): Promise<void>;
}

/** A call the brain cannot answer now, in words a window shows. */
const OUT_OF_REACH: Record<Exclude<OwnerReach, "live">, string> = {
  waking: "Waking the cloud brain.",
  asleep: "The cloud brain is asleep.",
  offline: "The cloud brain can't be reached.",
};

export class BrainOutOfReach extends Error {
  constructor(readonly reach: Exclude<OwnerReach, "live">) {
    super(OUT_OF_REACH[reach]);
  }
}

export type BrainPush = { type: "push"; push: RemotePush } | { type: "gap"; runIds: string[] };

/** A refused upgrade: the brain's address answers, but no brain runs there (410/502 while it sleeps). */
class Refused extends Error {}

/** Dials with `ws`; a refused upgrade reads as asleep, anything else, a dial that never answers too, as out of reach. */
function dial(url: string, connectMs: number): Promise<LinkSocket> {
  const ws = new WebSocket(url, { handshakeTimeout: connectMs });
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(linkSocket(ws)));
    ws.once("unexpected-response", () => {
      ws.terminate();
      reject(new Refused());
    });
    ws.once("error", reject);
  });
}

const DROPPED = "The connection to the cloud brain dropped before it answered.";
const RETRY_MS = 2 * 60_000;
const PING_MS = 20_000;
const CALL_MS = 60_000;
const CONNECT_MS = 10_000;

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/**
 * The Mac's one session with its cloud brain, as its owner. It dials at start, after every wake, and every two
 * minutes while not connected; a sleeping brain refuses the upgrade at once and nothing wakes it. Only a window's own
 * intent wakes the brain. Frames come for the runs in its interest; everything it hears goes to `onPush`.
 */
export class BrainLink {
  private session: PhoneSession | null = null;
  private connecting: Promise<PhoneSession | null> | null = null;
  private current: OwnerReach = "offline";
  /** The wake under way, which every call waiting for the brain shares. While it runs, a refused dial means not up yet. */
  private waking: Promise<void> | null = null;
  private interest: string[] = [];
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly pushes = new Set<(push: BrainPush) => void>();
  private readonly reaches = new Set<(reach: OwnerReach) => void>();
  private retry: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private dialed = 0;

  constructor(
    private readonly deps: {
      endpoint: BrainEndpoint;
      log: Logger;
      retryMs?: number;
      pingMs?: number;
      connectMs?: number;
      dial?: (url: string) => Promise<LinkSocket>;
    },
  ) {}

  get reach(): OwnerReach {
    return this.current;
  }

  /** Dials now and every few minutes while not connected. */
  start(): void {
    this.closed = false;
    if (this.retry) return;
    void this.connect();
    this.retry = setInterval(() => void (this.session ? undefined : this.connect()), this.deps.retryMs ?? RETRY_MS);
    this.retry.unref();
  }

  /**
   * One call to the brain. With `wake`, an unreachable brain is woken and the call waits for it; else it waits only for
   * a wake already under way, and fails at once without one.
   */
  async call<M extends RpcMethod>(method: M, params: RpcParams<M>, options: { wake: boolean }): Promise<RpcResults[M]> {
    let session = this.session ?? (await this.connect());
    if (!session && (options.wake || this.waking)) {
      await (options.wake ? this.wake() : this.waking?.catch(() => undefined));
      session = await this.connect();
    }
    if (!session) throw new BrainOutOfReach(this.current === "live" ? "offline" : this.current);
    return (await this.request(session, method, params)) as RpcResults[M];
  }

  /** The runs whose frames the Mac's windows want, sent again on every new session. */
  setInterest(runIds: readonly string[]): void {
    const next = [...new Set(runIds)].sort();
    if (next.join() === this.interest.join()) return;
    this.interest = next;
    this.session?.send({ t: "interest", runIds: next });
  }

  onPush(listener: (push: BrainPush) => void): () => void {
    this.pushes.add(listener);
    return () => this.pushes.delete(listener);
  }

  onReach(listener: (reach: OwnerReach) => void): () => void {
    this.reaches.add(listener);
    return () => this.reaches.delete(listener);
  }

  /** After something this Mac did that may have woken the brain: dial, at most every few seconds. */
  awoke(): void {
    if (this.session || this.closed || Date.now() - this.dialed < 5_000) return;
    void this.connect();
  }

  /** Hangs up and dials no more until started again. */
  close(): void {
    this.closed = true;
    if (this.retry) clearInterval(this.retry);
    this.retry = null;
    this.session?.close(1000, "closing");
    this.session = null;
    this.set("offline");
  }

  /** A dial or a wake that did not reach the brain. */
  private fell(reach: "asleep" | "offline"): void {
    if (!this.waking) this.set(reach);
  }

  private wake(): Promise<void> {
    if (this.waking) return this.waking;
    this.set("waking");
    this.waking = this.deps.endpoint.wake().then(
      () => void (this.waking = null),
      (error: unknown) => {
        this.waking = null;
        this.set("asleep");
        throw error;
      },
    );
    return this.waking;
  }

  private set(reach: OwnerReach): void {
    if (reach === this.current) return;
    this.current = reach;
    for (const listener of this.reaches) listener(reach);
  }

  private connect(): Promise<PhoneSession | null> {
    if (this.closed) return Promise.resolve(null);
    // One session at a time: a call that waited for a wake finds the one an earlier call opened after it.
    if (this.session) return Promise.resolve(this.session);
    this.connecting ??= this.open().finally(() => (this.connecting = null));
    return this.connecting;
  }

  private async open(): Promise<PhoneSession | null> {
    this.dialed = Date.now();
    const target = await this.deps.endpoint.locate().catch(() => null);
    if (!target) return null;
    let socket: LinkSocket;
    try {
      socket = await (this.deps.dial ?? ((url) => dial(url, this.deps.connectMs ?? CONNECT_MS)))(target.url);
    } catch (error) {
      this.fell(error instanceof Refused ? "asleep" : "offline");
      return null;
    }
    const result = await connectLink({ socket, crypto: nodeCrypto, device: target.ownerKeys, macKey: target.brainKey, hello: { device: { name: "Mac" } }, timeoutMs: 10_000 });
    if (!result.ok) {
      this.fell("asleep");
      return null;
    }
    const session = result.session;
    this.adopt(session);
    await this.request(session, "session.negotiate", { capabilities: [...PHONE_CAPABILITIES] }).catch(() => undefined);
    if (this.interest.length) session.send({ t: "interest", runIds: this.interest });
    // Frames the windows wanted may have been lost while no session ran.
    if (this.interest.length) this.emit({ type: "gap", runIds: this.interest });
    return session;
  }

  private adopt(session: PhoneSession): void {
    this.session = session;
    this.set("live");
    const ping = setInterval(() => session.send({ t: "ping", id: 0 }), this.deps.pingMs ?? PING_MS);
    ping.unref();
    session.onMessage((message) => this.receive(message));
    session.onClose(() => {
      clearInterval(ping);
      if (this.session === session) this.session = null;
      for (const [id, pending] of this.pending) {
        this.pending.delete(id);
        pending.reject(new Error(DROPPED));
      }
      this.set("asleep");
    });
  }

  private request(session: PhoneSession, method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The cloud brain did not answer in time."));
      }, CALL_MS);
      timer.unref();
      const settle =
        <T>(done: (value: T) => void) =>
        (value: T) => {
          clearTimeout(timer);
          done(value);
        };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      session.send({ t: "rpc", id, method, params });
    });
  }

  private receive(message: MacMessage): void {
    switch (message.t) {
      case "rpc.result":
      case "rpc.error": {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.t === "rpc.result") pending.resolve(message.result);
        else pending.reject(new Error(message.message));
        return;
      }
      case "push":
        return this.emit({ type: "push", push: message.push });
      case "gap":
        return this.emit({ type: "gap", runIds: message.runIds });
      case "closing":
        this.set("asleep");
        return;
      default:
        return;
    }
  }

  private emit(push: BrainPush): void {
    for (const listener of this.pushes) {
      try {
        listener(push);
      } catch (error) {
        this.deps.log.warn(`a push from the cloud brain was dropped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
