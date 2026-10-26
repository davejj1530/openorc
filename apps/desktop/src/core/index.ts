import { ProtectedSecretsClient } from "./protected-secrets";
import { BrowserClient } from "./browser-client";
import { PreviewClient } from "./preview-client";
import { PresenceClient } from "./presence";
import { windowPorts } from "./reply";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { MessagePortMain } from "electron";
import { OpenOrc, WorkerEmbedder, WorkerFormatter, type Broadcast, type EnvSnapshot, type RequestOrigin, type RpcReply, type Transport } from "@openorc/core";
import type { RpcRequest } from "@openorc/protocol";

/**
 * Utility-process entry. Main forks this once and hands it a MessagePort per
 * renderer. Everything interesting lives in @openorc/core; this file is the
 * Electron-specific glue.
 */

const dataDir = process.env["OPENORC_DATA_DIR"];
if (!dataDir) throw new Error("OPENORC_DATA_DIR is not set");
const fileKey = process.env["OPENORC_FILE_KEY"];
if (!fileKey) throw new Error("OPENORC_FILE_KEY is not set");
// Agents and shells inherit this process's environment. The key signs the file panel's viewer URLs and is dropped so theirs never carries it.
delete process.env["OPENORC_FILE_KEY"];

/** The latest startup or ready push, for a window that connects after it was sent. */
let lastStatus: Broadcast | null = null;
let pendingRequests = 0;
let closing = false;

const windows = windowPorts(answer);
const transport: Transport = {
  push(message) {
    if (message.type === "startup" || message.type === "ready") lastStatus = message;
    windows.broadcast(message);
  },
};

const secrets = new ProtectedSecretsClient((message) => process.parentPort.postMessage(message));
const browser = new BrowserClient((message) => process.parentPort.postMessage(message));
const preview = new PreviewClient((message) => process.parentPort.postMessage(message));
const presence = new PresenceClient((message) => process.parentPort.postMessage(message));
const corePromise = OpenOrc.create({
  browser: browser.execute,
  preview: preview.host,
  dataDir,
  fileKey,
  transport,
  slackSecrets: secrets.store("slack.secrets"),
  memorySecrets: secrets.store("memory.secrets"),
  githubSecrets: secrets.store("github.secrets"),
  remoteSecrets: secrets.store("remote.secrets"),
  pushSecrets: secrets.store("push.secrets"),
  presence: presence.inUse,
  // The embedding model runs in its own thread, so loading it and embedding memories never stall the core.
  embedder: new WorkerEmbedder(() => new Worker(join(import.meta.dirname, "embedder-worker.mjs"), { workerData: { cacheDir: dataDir } })),
  // Prettier formats in its own thread too, so a large file never stalls the core.
  formatter: new WorkerFormatter(() => new Worker(join(import.meta.dirname, "formatter-worker.mjs"))),
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

// Phones use the same fenced path as windows, so an update waits for their requests and refuses new ones.
void corePromise.then((core) => core.remote.attach(answer));

function attach(port: MessagePortMain): void {
  windows.attach(port);
  port.start();
  // A renderer that connects after startup still needs to know we are up, or what we are waiting for.
  if (lastStatus) port.postMessage(lastStatus);
}

/**
 * Counted from the moment a request arrives, with no await before, so an update never fences one mid-flight. Only a
 * phone's session passes an origin; a window's request has none.
 */
async function answer(request: RpcRequest, origin?: RequestOrigin): Promise<RpcReply> {
  if (closing) return { type: "rpc.error", id: request.id, message: "OpenOrc is restarting to update. Please wait." };
  pendingRequests++;
  try {
    return await (await corePromise).handle(request, origin);
  } finally {
    pendingRequests--;
  }
}

process.parentPort.on("message", (e) => {
  if (browser.receive(e.data)) return;
  if (preview.receive(e.data)) return;
  if (presence.receive(e.data)) return;
  if (secrets.receive(e.data)) return;
  if (e.data?.type === "update:prepare" && typeof e.data.id === "string") {
    void prepareUpdate(e.data.id);
    return;
  }
  if (e.data?.type === "shutdown") {
    void shutdown();
    return;
  }
  const [port, media] = e.ports;
  if (port && !closing) attach(port);
  if (media && !closing) void corePromise.then((core) => core.devices.attachMedia(media));
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
