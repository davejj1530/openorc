import { ProtectedSecretsClient } from "./protected-secrets";
import { BrowserClient } from "./browser-client";
import { PreviewClient } from "./preview-client";
import { PresenceClient } from "./presence";
import { DownloadClient } from "./download";
import { windowPorts, type WindowPort } from "./reply";
import { coreLogPath, recordUncaughtErrors } from "../shared/crash-log";
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
  /** What only the place itself can supply: its terminal, its Trash, its devices and the OpenOrc Cloud server it talks to. */
  options: Pick<OpenOrcOptions, "terminal" | "trash" | "deviceSystem" | "accountServer">;
  /** A development or QA build: benchmarks are served. */
  qa: boolean;
  /** Ends the process once everything it owes main has been written. */
  exit(code: number): void;
}

export interface CoreSession {
  /** The core once it has started; reads of the ledger are answered before then (OpenOrc.open). */
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
  downloads: DownloadClient;
}

function coreOptions(host: CoreHost, transport: Transport, { secrets, browser, preview, presence, downloads }: MainClients): OpenOrcOptions {
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
    accountSecrets: secrets.store("account.secrets"),
    presence: presence.inUse,
    chooseDownload: downloads.choose,
    openBrowser: (url) => host.post({ type: "open-browser", url }),
    // The embedding model runs in its own thread, so loading it and embedding memories never stall the core.
    embedder: new WorkerEmbedder(() => new Worker(join(host.workerDir, "embedder-worker.mjs"), { workerData: { cacheDir: host.dataDir } })),
    // Prettier formats in its own thread too, so a large file never stalls the core.
    formatter: new WorkerFormatter(() => new Worker(join(host.workerDir, "formatter-worker.mjs"))),
    intelligence: new WorkerIntelligence(() => new Worker(join(host.workerDir, "intelligence-worker.mjs"), { resourceLimits: { maxOldGenerationSizeMb: 1024 } })),
    benchmarks: host.qa,
    ...host.options,
  };
}

/** Why main asks the core to close: to install an update, or to start it somewhere else. */
type ClosePurpose = "update" | "switch";

/** What a close is told while a request is on its way through the core: true for a moment at a time, as windows ask for lists. */
const MID_REQUEST: Record<ClosePurpose, string> = {
  update: "OpenOrc is processing a request. Try restarting to update again in a moment.",
  switch: "OpenOrc is processing a request. Try again in a moment.",
};

/**
 * The core, served to main and the windows. Everything interesting lives in @openorc/core; this is the glue between
 * it and the app, shared by every place the core runs.
 */
class CoreServer implements CoreSession {
  readonly core: Promise<OpenOrc>;
  closing = false;
  /** The core before it has started: it answers reads of the ledger at once. */
  private readonly opened: Promise<OpenOrc>;
  /** The latest startup or ready push, for a window that connects after it was sent. */
  private lastStatus: Broadcast | null = null;
  private pendingRequests = 0;
  /** What a request is told once the core is closing. */
  private closingWords = "OpenOrc is restarting to update. Please wait.";
  private readonly windows = windowPorts((request) => this.answer(request));
  private readonly clients: MainClients;

  constructor(private readonly host: CoreHost) {
    this.clients = {
      secrets: new ProtectedSecretsClient(host.post),
      browser: new BrowserClient(host.post),
      preview: new PreviewClient(host.post),
      presence: new PresenceClient(host.post),
      downloads: new DownloadClient(host.post),
    };
    const transport: Transport = {
      push: (message) => {
        if (message.type === "startup" || message.type === "ready") this.lastStatus = message;
        this.windows.broadcast(message);
      },
    };
    // Open answers reads of the ledger at once; the core is started once the login shell has answered (OpenOrc.open).
    this.opened = OpenOrc.open(coreOptions(host, transport, this.clients));
    this.core = this.opened.then(async (core) => {
      await core.started;
      return core;
    });
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
    if (this.closing) return { type: "rpc.error", id: request.id, message: this.closingWords };
    this.pendingRequests++;
    try {
      return await (await this.opened).handle(request, origin);
    } finally {
      this.pendingRequests--;
    }
  }

  /**
   * Why the core will not close now, in the words of what was asked, or null once it is fenced for closing. `retry`
   * marks a refusal that passes by itself: a request caught mid-flight. Never yields, so nothing starts between the
   * checks and the fence.
   */
  private closeRefusal(core: OpenOrc, purpose: ClosePurpose): { reason: string; retry?: true } | null {
    if (this.closing) return { reason: "OpenOrc is already shutting down." };
    if (this.pendingRequests > 0) return { reason: MID_REQUEST[purpose], retry: true };
    const reason = purpose === "update" ? core.prepareForUpdate() : core.prepareForSwitch();
    return reason ? { reason } : null;
  }

  /** Closes the core for an update, or for main to start it somewhere else, unless that would cut something short. */
  private async prepareClose(id: string, purpose: ClosePurpose): Promise<void> {
    const refusal = this.closeRefusal(await this.core, purpose);
    if (refusal) {
      this.host.post({ type: "update:blocked", id, ...refusal });
      return;
    }
    // No await between the admission check and fencing renderer requests.
    if (purpose === "switch") this.closingWords = "OpenOrc is switching where it runs. Please wait.";
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
    const { browser, preview, presence, secrets, downloads } = this.clients;
    if (browser.receive(message) || preview.receive(message) || presence.receive(message) || secrets.receive(message) || downloads.receive(message)) return true;
    const { type, id, purpose } = (message && typeof message === "object" ? message : {}) as { type?: unknown; id?: unknown; purpose?: unknown };
    if (type === "update:prepare" && typeof id === "string") void this.prepareClose(id, purpose === "switch" ? "switch" : "update");
    else if (type === "shutdown") void this.shutdown();
    // Back from sleep, maybe on another network: the account's server is dialed again now, not at the next retry.
    else if (type === "awoke") void this.core.then((core) => core.account?.awoke()).catch((error: unknown) => console.error("[core] waking", error));
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
  // Before anything can fail: main starts a core that stopped again, and this log is what says why it stopped.
  recordUncaughtErrors(coreLogPath(host.dataDir));
  const server = new CoreServer(host);
  process.on("SIGTERM", () => void server.shutdown());
  process.on("SIGINT", () => void server.shutdown());
  console.log(`[core] up, pid ${process.pid}, data in ${host.dataDir}`);
  return server;
}
