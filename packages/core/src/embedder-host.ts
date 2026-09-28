/** The worker-thread side of the embedder, kept apart from the rest of the core so a worker loads only the model. */
export { serveEmbedder } from "@openorc/memory/embedder-host";
