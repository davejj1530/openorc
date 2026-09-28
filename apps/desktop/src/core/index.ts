import { ProtectedSecretsClient } from "./protected-secrets";
import { BrowserClient } from "./browser-client";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { MessagePortMain } from "electron";
import { OpenOrc, WorkerEmbedder, type EnvSnapshot, type Transport } from "@openorc/core";
import { RpcRequest, type CorePush } from "@openorc/protocol";

/**
 * Utility-process entry. Main forks this once and hands it a MessagePort per
 * renderer. Everything interesting lives in @openorc/core; this file is the
 * Electron-specific glue.
 */

const dataDir = process.env["OPENORC_DATA_DIR"];
if (!dataDir) throw new Error("OPENORC_DATA_DIR is not set");

let ports: MessagePortMain[] = [];
/** The latest startup or ready push, for a window that connects after it was sent. */
let lastStatus: CorePush | null = null;
let pendingRequests = 0;
let closing = false;

const transport: Transport = {
  push(message) {
    if (message.type === "startup" || message.type === "ready") lastStatus = message;
    for (const p of ports) p.postMessage(message);
  },
};

const secrets = new ProtectedSecretsClient((message) => process.parentPort.postMessage(message));
const browser = new BrowserClient((message) => process.parentPort.postMessage(message));
const corePromise = OpenOrc.create({
  browser: browser.execute,
  dataDir,
  transport,
  slackSecrets: secrets.store("slack.secrets"),
  memorySecrets: secrets.store("memory.secrets"),
  // The embedding model runs in its own thread, so loading it and embedding memories never stall the core.
  embedder: new WorkerEmbedder(() => new Worker(join(import.meta.dirname, "embedder-worker.mjs"), { workerData: { cacheDir: dataDir } })),
  benchmarks: __OPENORC_QA__,
});

// Main hosts the Terminal panels and wants the login PATH the core adopted.
// It hears every accepted snapshot, the startup one included: create() has
// already published it by the time this runs, so it is sent by hand. Only
// the fields main uses cross the boundary; the full environment stays here.
void corePromise.then((core) => {
  const publish = ({ revision, shell, path, binaries }: EnvSnapshot) => process.parentPort.postMessage({ type: "shell-env", snapshot: { revision, shell, path, binaries } });
  core.environment.onChange(publish);
  publish(core.environment.current());
});

function attach(port: MessagePortMain): void {
  ports.push(port);
  port.on("message", (e) => {
    const parsed = RpcRequest.safeParse(e.data);
    if (!parsed.success) {
      console.warn(`[core] dropped malformed message: ${parsed.error.message}`);
      return;
    }
    if (closing) {
      port.postMessage({ type: "rpc.error", id: parsed.data.id, message: "OpenOrc is restarting to update. Please wait." });
      return;
    }
    pendingRequests++;
    void corePromise.then((core) => core.handle(parsed.data)).finally(() => pendingRequests--);
  });
  port.on("close", () => {
    ports = ports.filter((p) => p !== port);
  });
  port.start();
  // A renderer that connects after startup still needs to know we are up, or what we are waiting for.
  if (lastStatus) port.postMessage(lastStatus);
}

process.parentPort.on("message", (e) => {
  if (browser.receive(e.data)) return;
  if (secrets.receive(e.data)) return;
  if (e.data?.type === "update:prepare" && typeof e.data.id === "string") {
    void prepareUpdate(e.data.id);
    return;
  }
  if (e.data?.type === "shutdown") {
    void shutdown();
    return;
  }
  const port = e.ports[0];
  if (port && !closing) attach(port);
});

async function prepareUpdate(id: string): Promise<void> {
  const core = await corePromise;
  let reason: string | null;
  if (closing) reason = "OpenOrc is already shutting down.";
  else if (pendingRequests > 0) reason = "OpenOrc is processing a request. Try restarting to update again in a moment.";
  else reason = core.prepareForUpdate();
  if (reason) {
    process.parentPort.postMessage({ type: "update:blocked", id, reason });
    return;
  }
  // No await between the admission check and fencing renderer requests.
  process.parentPort.postMessage({ type: "update:prepared", id });
  await shutdown();
}

async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    await (await corePromise).close();
    process.exit(0);
  } catch (error) {
    console.error("[core] shutdown failed", error);
    process.exit(1);
  }
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

console.log(`[core] up, pid ${process.pid}, data in ${dataDir}`);
