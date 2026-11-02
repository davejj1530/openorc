import { parentPort } from "node:worker_threads";
import { serveIntelligence } from "@openorc/core/intelligence-host";

if (!parentPort) throw new Error("Code intelligence must run in its worker thread.");
serveIntelligence(parentPort);
