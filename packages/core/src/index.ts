export { OpenOrc, type OpenOrcOptions } from "./openorc.js";
export { ShellEnvironment, type EnvSnapshot, type HarnessBinaries, type RefreshResult, type ShellProbe } from "./services/shell-environment.js";
export { FrameCoalescer } from "./frames.js";
export type { Transport, Logger } from "./transport.js";
export { slugify, portBlockFor } from "./services/workspace.js";
export type { SlackSecretStore } from "./services/slack/service.js";
export type { ProtectedSecretStore } from "./services/extraction-credentials.js";
export { WorkerEmbedder, type EmbedWorker } from "@openorc/memory";
