import { ProtectedSecretsClient } from "./protected-secrets";
import { BrowserClient } from "./browser-client";
import { PreviewClient } from "./preview-client";
import { PresenceClient } from "./presence";
import { windowPorts, type WindowPort } from "./reply";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { OpenOrc, WorkerEmbedder, WorkerFormatter, WorkerIntelligence, type Broadcast, type EnvSnapshot, type OpenOrcOptions, type RequestOrigin, type RpcReply, type Transport } from "@openorc/core";
import type { RpcRequest } from "@openorc/protocol";

/**
 * Where the desktop's core runs: Electron's utility process, or Node inside a WSL distribution with the app's windows
 * on the Windows side. Both are given main's private channel and each window's; this is what else differs.
 */
export interface CoreHost {
  dataDir: string;
  /** Signs the file panel's viewer URLs. Main verifies them with the same key. */
  fileKey: string;
  /** To main, on the private channel. */
  post(message: unknown): void;
  /** The folder the worker threads' entry files sit in. */
  workerDir: string;
  /** What only the place itself can supply: its terminal, its Trash, the runner's files and the brain it installs. */
  options: Pick<OpenOrcOptions, "terminal" | "trash" | "cloudRunnerFiles" | "cloudBrainBundle" | "deviceSystem">;
  /** A development or QA build: benchmarks are served, and cloud sandboxes are simulated until a service is connected. */
  qa: boolean;
  /** Ends the process once everything it owes main has been written. */
  exit(code: number): void;
}

export interface CoreSession {
  readonly core: Promise<OpenOrc>;
  /** True once shutdown began: nothing new is attached or answered. */
  readonly closing: boolean;
  /** Takes a message main sent on the private channel. False when it is not one the session reads. */
  receive(message: unknown): boolean;
  /** Connects one window, and tells it where startup stands. */
  attach(port: WindowPort): void;
  shutdown(): Promise<void>;
}

/** Main's services the core reaches over the private channel. */
interface MainClients {
  secrets: ProtectedSecretsClient;
  browser: BrowserClient;
  preview: PreviewClient;
  presence: PresenceClient;
}

function coreOptions(host: CoreHost, transport: Transport, { secrets, browser, preview, presence }: MainClients): OpenOrcOptions {
  return {
    browser: browser.execute,
    preview: preview.host,
    dataDir: host.dataDir,
    fileKey: host.fileKey,
    transport,
    slackSecrets: secrets.store("slack.secrets"),
    memorySecrets: secrets.store("memory.secrets"),
    githubSecrets: secrets.store("github.secrets"),
    remoteSecrets: secrets.store("remote.secrets"),
    pushSecrets: secrets.store("push.secrets"),
    cloudSecrets: secrets.store("cloud.secrets"),
    claudeCloudSecrets: secrets.store("claude-cloud.secrets"),
    codexCloudSecrets: secrets.store("codex-cloud.secrets"),
    opencodeCloudSecrets: secrets.store("opencode-cloud.secrets"),
    cloudEnvSecrets: secrets.store("cloud-env.secrets"),
    cloudBrainSecrets: secrets.store("cloud-brain.secrets"),
    cloudBrainMoveSecrets: secrets.store("cloud-brain-move.secrets"),
    presence: presence.inUse,
    // The embedding model runs in its own thread, so loading it and embedding memories never stall the core.
    embedder: new WorkerEmbedder(() => new Worker(join(host.workerDir, "embedder-worker.mjs"), { workerData: { cacheDir: host.dataDir } })),
    // Prettier formats in its own thread too, so a large file never stalls the core.
    formatter: new WorkerFormatter(() => new Worker(join(host.workerDir, "formatter-worker.mjs"))),
    intelligence: new WorkerIntelligence(() => new Worker(join(host.workerDir, "intelligence-worker.mjs"), { resourceLimits: { maxOldGenerationSizeMb: 1024 } })),
    benchmarks: host.qa,
    cloudOffered: true,
    // Development and QA builds simulate sandboxes on this Mac until a service is connected; a release asks for one.
    cloudSimulated: host.qa,
    ...host.options,
  };
}

/** The computer went to sleep or woke: conversations working here carry on in the cloud meanwhile, and come back. */
function powerChanged(core: OpenOrc, state: unknown): Promise<void> {
  // Best effort before sleep: what is new on the chosen projects' branches reaches a brain that is awake.
  if (state === "suspend") return Promise.all([core.cloudStandby.away(), core.brainRouting?.freshen()]).then(() => undefined);
  // Back from sleep, maybe on another network: the cloud brain is dialed again now, not at the next retry, and woken
  // if a phone used it meanwhile, so its new threads list here.
  if (core.brainRouting?.active) {
    core.brainRouting.link.awoke();
    void core.brainRouting.catchUp();
  }
  return core.cloudStandby.back();
}

/**
 * The core, served to main and the windows. Everything interesting lives in @openorc/core; this is the glue between
 * it and the app, shared by every place the core runs.
 */
class CoreServer implements CoreSession {
  readonly core: Promise<OpenOrc>;
  closing = false;
  /** The latest startup or ready push, for a window that connects after it was sent. */
  private lastStatus: Broadcast | null = null;
  private pendingRequests = 0;
  private readonly windows = windowPorts((request) => this.answer(request));
  private readonly clients: MainClients;

  constructor(private readonly host: CoreHost) {
    this.clients = { secrets: new ProtectedSecretsClient(host.post), browser: new BrowserClient(host.post), preview: new PreviewClient(host.post), presence: new PresenceClient(host.post) };
    const transport: Transport = {
      push: (message) => {
        if (message.type === "startup" || message.type === "ready") this.lastStatus = message;
        this.windows.broadcast(message);
      },
    };
    this.core = OpenOrc.create(coreOptions(host, transport, this.clients));
    // Main hosts the Terminal panels and wants the login PATH the core adopted.
    // It hears every accepted snapshot, the startup one included: create() has
    // already published it by the time this runs, so it is sent by hand. Only
    // the fields main uses cross the boundary; the full environment stays here.
    void this.core.then((core) => {
      const publish = ({ revision, shell, path, binaries }: EnvSnapshot) => host.post({ type: "shell-env", snapshot: { revision, shell, path, binaries } });
      core.environment.onChange(publish);
      publish(core.environment.current());
    });
    // Phones use the same fenced path as windows, so an update waits for their requests and refuses new ones.
    void this.core.then((core) => core.remote.attach((request, origin) => this.answer(request, origin)));
  }

  /**
   * Counted from the moment a request arrives, with no await before, so an update never fences one mid-flight. Only a
   * phone's session passes an origin; a window's request has none.
   */
  private async answer(request: RpcRequest, origin?: RequestOrigin): Promise<RpcReply> {
    if (this.closing) return { type: "rpc.error", id: request.id, message: "OpenOrc is restarting to update. Please wait." };
    this.pendingRequests++;
    try {
      return await (await this.core).handle(request, origin);
    } finally {
      this.pendingRequests--;
    }
  }

  private async prepareUpdate(id: string): Promise<void> {
    const core = await this.core;
    let reason: string | null;
    if (this.closing) reason = "OpenOrc is already shutting down.";
    else if (this.pendingRequests > 0) reason = "OpenOrc is processing a request. Try restarting to update again in a moment.";
    else reason = core.prepareForUpdate();
    if (reason) {
      this.host.post({ type: "update:blocked", id, reason });
      return;
    }
    // No await between the admission check and fencing renderer requests.
    this.host.post({ type: "update:prepared", id });
    await this.shutdown();
  }

  async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    try {
      await (await this.core).close();
      this.host.exit(0);
    } catch (error) {
      console.error("[core] shutdown failed", error);
      this.host.exit(1);
    }
  }

  receive(message: unknown): boolean {
    const { browser, preview, presence, secrets } = this.clients;
    if (browser.receive(message) || preview.receive(message) || presence.receive(message) || secrets.receive(message)) return true;
    const { type, id, state } = (message && typeof message === "object" ? message : {}) as { type?: unknown; id?: unknown; state?: unknown };
    if (type === "update:prepare" && typeof id === "string") void this.prepareUpdate(id);
    else if (type === "shutdown") void this.shutdown();
    else if (type === "power") void this.core.then((core) => powerChanged(core, state)).catch((error: unknown) => console.error("[core] cloud takeover", error));
    else return false;
    return true;
  }

  attach(port: WindowPort): void {
    if (this.closing) return;
    this.windows.attach(port);
    // A renderer that connects after startup still needs to know we are up, or what we are waiting for.
    if (this.lastStatus) port.postMessage(this.lastStatus);
  }
}

/** Starts the core in this process and serves it to main and the windows. */
export function serveCore(host: CoreHost): CoreSession {
  const server = new CoreServer(host);
  process.on("SIGTERM", () => void server.shutdown());
  process.on("SIGINT", () => void server.shutdown());
  console.log(`[core] up, pid ${process.pid}, data in ${host.dataDir}`);
  return server;
}
