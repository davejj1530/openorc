import { parentPort } from "node:worker_threads";
import { serveFormatter } from "@openorc/core/formatter-host";

/** Worker-thread entry for the bundled Prettier, built beside core.mjs. Formatting a large file blocks this thread instead of the core's. */
serveFormatter(parentPort!);
