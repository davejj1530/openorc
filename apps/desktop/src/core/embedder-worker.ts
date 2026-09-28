import { parentPort, workerData } from "node:worker_threads";
import { serveEmbedder } from "@openorc/core/embedder-host";

/**
 * Worker-thread entry for memory's embedding model, built beside core.mjs. Loading the model and embedding a batch
 * are synchronous native calls; here they block this thread instead of the core's.
 */
serveEmbedder(parentPort!, (workerData as { cacheDir: string }).cacheDir);
