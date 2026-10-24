import type { CorePush, RpcMethod, RpcParams, RpcResults } from "@openorc/protocol";
import type { ClientPush, CoreConnection } from "@openorc/client";

type Listener<T> = (value: T) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

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
  ready: { mcpPort: number } | null = null;
  /** What the core is doing before it is ready, when that takes a while. */
  startup: string | null = null;

  connect(): void {
    window.addEventListener("message", (e) => {
      if (e.source !== window || e.data !== "openorc:port" || e.ports.length === 0) return;
      const port = e.ports[0] as MessagePort;
      this.port = port;
      port.onmessage = (m: MessageEvent<CorePush>) => this.receive(m.data);
      port.start();
      for (const q of this.queued.splice(0)) port.postMessage({ type: "rpc", ...q });
    });
    window.openorc.connectBridge();
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
    for (const l of this.pushListeners) l(push);
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
        for (const l of this.readyListeners) l(this.ready);
        this.push({ type: "session", resumed });
        return;
      }
      case "rpc.result": {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        p.resolve(msg.result);
        return;
      }
      case "rpc.error": {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        console.error(`rpc ${msg.id} failed: ${msg.message}`);
        p.reject(new Error(msg.message));
        return;
      }
      case "frame":
        this.push({ type: "frame", frame: msg.frame });
        return;
      case "invalidate":
        this.push({ type: "invalidate", keys: msg.keys });
        return;
      case "notify": {
        const { type: _push, ...notice } = msg;
        this.push({ type: "notify", notice });
        return;
      }
      case "log":
        for (const l of this.logListeners) l({ level: msg.level, message: msg.message });
        return;
      case "bench.done":
        for (const l of this.benchListeners) l({ eventsSent: msg.eventsSent, framesSent: msg.framesSent, durationMs: msg.durationMs });
        return;
    }
  }

  private setStartup(message: string | null): void {
    this.startup = message;
    for (const l of this.startupListeners) l(message);
  }
}

export const core = new CoreClient();
