import type { TextEmbedder } from "@openorc/memory";
import type { BrowserHost } from "@openorc/protocol";
import type { DeviceSystem } from "./devices/system.js";
import type { RemoteNetwork } from "./remote/remote-access.js";
import type { ProtectedSecretStore } from "./services/extraction-credentials.js";
import type { BundledFormatter } from "./services/file-format.js";
import type { ShellProbe } from "./services/shell-environment.js";
import type { SlackSecretStore } from "./services/slack/service.js";
import type { Transport } from "./transport.js";

/** What the host gives the core. */
export interface OpenOrcOptions {
  browser?: BrowserHost;
  slackSecrets?: SlackSecretStore;
  memorySecrets?: ProtectedSecretStore;
  /** Keeps the reviewer app's private key. Without it, reviews post only as the user. */
  githubSecrets?: ProtectedSecretStore;
  /** Keeps the Mac's key pair for phone access. Without it, phone access cannot turn on. */
  remoteSecrets?: ProtectedSecretStore;
  /** Where phone access listens and how the Mac describes itself. Tests pass port 0, a fixed machine and a fake APNs. */
  remoteNetwork?: RemoteNetwork;
  /** Keeps the Apple push key phone alerts are signed with. Without it, no key can be added. */
  pushSecrets?: ProtectedSecretStore;
  /** Whether someone is using the Mac, asked once per alert. Without it, the Mac always reads as away. */
  presence?: () => Promise<boolean>;
  /** Where memory's embedding model runs. Defaults to the core's own thread, where loading it and each batch block everything else. */
  embedder?: TextEmbedder;
  /** The bundled Prettier, run off the core's thread. Without it, files format only with the project's own formatter. */
  formatter?: BundledFormatter;
  dataDir: string;
  /**
   * Signs the file panel's viewer URLs; the app verifies them with the same key before serving a file. A core
   * without one signs with a key nobody holds, so its viewer URLs load nowhere. Tests pass none.
   */
  fileKey?: string;
  transport: Transport;
  /** In-memory database, for tests. */
  ephemeral?: boolean;
  /**
   * How the login shell is asked for PATH and the harness binaries. Defaults
   * to the real shell, except that an ephemeral core inherits this process's
   * environment instead: a test should not pay for a login shell it never
   * asked about. Pass a probe to test that path on purpose.
   */
  shellProbe?: ShellProbe;
  /** Serves the bench.* methods, which stream synthetic events and write a synthetic thread into the ledger. Development and QA builds only. */
  benchmarks?: boolean;
  /** How the Device panel's helpers run processes. Tests pass a fake, so no simulator tool or hub ever runs. */
  deviceSystem?: DeviceSystem;
}
