import type { CorePush, RpcMethod, RpcParams, RpcResults } from "@openorc/protocol";
import type { ClientPush, CoreConnection } from "@openorc/client";

export type DevicePanelPush = Extract<CorePush, { type: "device.panel" }>;
export type HostedTerminalPush = Extract<CorePush, { type: "hosted.terminal" }>;

type Listener<T> = (value: T) => void;

function emit<T>(listeners: Set<Listener<T>>, value: T): void {
  for (const listener of listeners) listener(value);
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

/** What a call is told when the core stopped before answering it. */
const CORE_STOPPED = "OpenOrc stopped before answering. It is starting again, so try again in a moment.";

/**
 * The renderer's one line to the core: request/response RPC plus pushes over the MessagePort main handed us. A window
 * hears every run's frames, so interest is never sent. Logs, benchmarks, startup and the MCP port are desktop matters
 * with listeners of their own.
 */
class CoreClient implements CoreConnection {
  readonly delivery = "all";
  private port: MessagePort | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly queued: Array<{ id: number; method: string; params: unknown }> = [];
  private readonly pushListeners = new Set<Listener<ClientPush>>();
  private readonly logListeners = new Set<Listener<{ level: string; message: string }>>();
  private readonly benchListeners = new Set<Listener<{ eventsSent: number; framesSent: number; durationMs: number }>>();
  private readonly readyListeners = new Set<Listener<{ mcpPort: number }>>();
  private readonly startupListeners = new Set<Listener<string | null>>();
  private readonly devicePanelListeners = new Set<Listener<DevicePanelPush>>();
  private readonly terminalListeners = new Set<Listener<HostedTerminalPush>>();
  private readonly mediaListeners = new Set<Listener<MessagePort>>();
  private media: MessagePort | null = null;
  private listening = false;
  ready: { mcpPort: number } | null = null;
  /** What the core is doing before it is ready, when that takes a while. */
  startup: string | null = null;

  /** Asks the preload for a port. However often it is asked, one window listener takes the port that arrives. */
  connect(): void {
    if (!this.listening) window.addEventListener("message", this.fromPreload);
    this.listening = true;
    window.openorc.connectBridge();
  }

  /** The preload's word, and only the preload's: a port to the core, or that the core behind the port stopped. */
  private readonly fromPreload = (e: MessageEvent) => {
    if (e.source !== window) return;
    if (e.data === "openorc:core-lost") return this.lose();
    if (e.data !== "openorc:port" || e.ports.length === 0) return;
    const port = e.ports[0] as MessagePort;
    this.port = port;
    port.onmessage = (m: MessageEvent<CorePush>) => this.receive(m.data);
    port.start();
    for (const q of this.queued.splice(0)) port.postMessage({ type: "rpc", ...q });
    const media = e.ports[1];
    if (media) {
      this.media = media;
      emit(this.mediaListeners, media);
    }
  };

  /**
   * The core stopped by itself, and main is starting another. What it was asked and never answered fails now instead of
   * waiting forever: a send gives its words back to the composer, and a list says it could not load. Later calls wait for
   * the next port, and the new core's ready resumes the session, which loads everything again.
   */
  private lose(): void {
    const port = this.port;
    if (!port) return;
    port.onmessage = null;
    port.close();
    this.port = null;
    // Calls only queue while there is no port, so every one still waiting went to the core that stopped.
    const unanswered = [...this.pending.values()];
    this.pending.clear();
    for (const call of unanswered) call.reject(new Error(CORE_STOPPED));
    this.setStartup("OpenOrc stopped unexpectedly. Starting it again…");
  }

  /** The port device streams travel on, beside the RPC port. A listener hears the current one and every later one. */
  onMediaPort(fn: Listener<MessagePort>): () => void {
    this.mediaListeners.add(fn);
    if (this.media) fn(this.media);
    return () => this.mediaListeners.delete(fn);
  }
  /** A watched cloud terminal's output and changes (`hosted.terminal.watch`). */
  onHostedTerminal(fn: Listener<HostedTerminalPush>): () => void {
    this.terminalListeners.add(fn);
    return () => this.terminalListeners.delete(fn);
  }

  onDevicePanel(fn: Listener<DevicePanelPush>): () => void {
    this.devicePanelListeners.add(fn);
    return () => this.devicePanelListeners.delete(fn);
  }

  call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> {
    const id = this.nextId++;
    return new Promise<RpcResults[M]>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      const message = { id, method, params };
      if (this.port) this.port.postMessage({ type: "rpc", ...message });
      else this.queued.push(message);
    });
  }

  setFrameInterest(): void {}

  onPush(fn: Listener<ClientPush>): () => void {
    this.pushListeners.add(fn);
    return () => this.pushListeners.delete(fn);
  }
  onLog(fn: Listener<{ level: string; message: string }>): () => void {
    this.logListeners.add(fn);
    return () => this.logListeners.delete(fn);
  }
  onBenchDone(fn: Listener<{ eventsSent: number; framesSent: number; durationMs: number }>): () => void {
    this.benchListeners.add(fn);
    return () => this.benchListeners.delete(fn);
  }
  onReady(fn: Listener<{ mcpPort: number }>): () => void {
    this.readyListeners.add(fn);
    if (this.ready) fn(this.ready);
    return () => this.readyListeners.delete(fn);
  }

  onStartup(fn: Listener<string | null>): () => void {
    this.startupListeners.add(fn);
    return () => this.startupListeners.delete(fn);
  }

  private push(push: ClientPush): void {
    emit(this.pushListeners, push);
  }

  private receive(msg: CorePush): void {
    switch (msg.type) {
      case "startup":
        this.setStartup(msg.message);
        return;
      case "ready": {
        // A second ready means the core started again, and whatever it pushed in between is lost.
        const resumed = this.ready !== null;
        this.ready = { mcpPort: msg.mcpPort };
        this.setStartup(null);
        emit(this.readyListeners, this.ready);
        this.push({ type: "session", resumed });
        return;
      }
      case "rpc.result":
      case "rpc.error":
        this.answer(msg);
        return;
      case "frame":
        this.push({ type: "frame", frame: msg.frame });
        return;
      case "invalidate":
        this.push({ type: "invalidate", keys: msg.keys });
        return;
      case "gap":
        this.push({ type: "gap", runIds: msg.runIds });
        return;
      case "device.panel":
        emit(this.devicePanelListeners, msg);
        return;
      case "hosted.terminal":
        emit(this.terminalListeners, msg);
        return;
      case "notify": {
        const { type: _push, ...notice } = msg;
        this.push({ type: "notify", notice });
        return;
      }
      case "log":
        emit(this.logListeners, { level: msg.level, message: msg.message });
        return;
      case "bench.done":
        emit(this.benchListeners, { eventsSent: msg.eventsSent, framesSent: msg.framesSent, durationMs: msg.durationMs });
        return;
    }
  }

  /** A call's answer: its result, or its failure, logged unless the read was only superseded. */
  private answer(msg: Extract<CorePush, { type: "rpc.result" | "rpc.error" }>): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.type === "rpc.result") return p.resolve(msg.result);
    if (!msg.superseded) console.error(`rpc ${msg.id} failed: ${msg.message}`);
    p.reject(new Error(msg.message));
  }

  private setStartup(message: string | null): void {
    this.startup = message;
    for (const l of this.startupListeners) l(message);
  }
}

export const core = new CoreClient();
