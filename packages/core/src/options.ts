import type { TextEmbedder } from "@openorc/memory";
import type { BrowserHost, PreviewHost } from "@openorc/protocol";
import type { DeviceSystem } from "./devices/system.js";
import type { RemoteNetwork } from "./remote/remote-access.js";
import type { ProtectedSecretStore } from "./services/extraction-credentials.js";
import type { BundledFormatter } from "./services/file-format.js";
import type { ShellProbe } from "./services/shell-environment.js";
import type { SlackSecretStore } from "./services/slack/service.js";
import type { SpawnTerminal } from "./services/terminal-process.js";
import type { Transport } from "./transport.js";
import type { IntelligenceEngine } from "./editor/worker-intelligence.js";

/** What the host gives the core. */
export interface OpenOrcOptions {
  browser?: BrowserHost;
  /** What the Mac's Preview shows, for phones. Read-only; without it, every thread's Preview reads as closed. */
  preview?: PreviewHost;
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
  /** Keeps the OpenOrc account's session. Without it nobody can sign in, and nothing else changes. */
  accountSecrets?: ProtectedSecretStore;
  /** The OpenOrc server. Without one the account reads as signed out, signing in is refused, and nothing reaches a server. */
  accountServer?: string;
  /** Whether someone is using the Mac, asked once per alert. Without it, the Mac always reads as away. */
  presence?: () => Promise<boolean>;
  /** Moves a file or folder to the system Trash. Without it, nothing the user asks to remove is removed. */
  trash?: (file: string) => Promise<void>;
  /** Asks the native Save As dialog for a destination. The renderer never supplies a filesystem path. */
  chooseDownload?: (name: string) => Promise<string | null>;
  /** Opens a web page in the person's browser, as a GitHub sign-in the core waits on needs. Absent where nothing can. */
  openBrowser?: (url: string) => void;
  /** Where memory's embedding model runs. Defaults to the core's own thread, where loading it and each batch block everything else. */
  embedder?: TextEmbedder;
  /** The bundled Prettier, run off the core's thread. Without it, files format only with the project's own formatter. */
  formatter?: BundledFormatter;
  /** TypeScript/JavaScript analysis, isolated from the core's event loop. Starts only when the file editor asks. */
  intelligence?: IntelligenceEngine;
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
  /** The environment the core starts from instead of this process's, so two cores in one test keep their agent folders apart. */
  shellEnv?: NodeJS.ProcessEnv;
  /** Serves the bench.* methods, which stream synthetic events and write a synthetic thread into the ledger. Development and QA builds only. */
  benchmarks?: boolean;
  /**
   * How the Device panel's helpers run processes. Tests pass a fake, so no simulator tool or hub ever runs. Null on a
   * machine with no simulators or emulators: nothing runs and agents have no device tool.
   */
  deviceSystem?: DeviceSystem | null;
  /** Starts a command in a terminal of its own, for CLIs whose sign-in screens need one. Without it they get pipes. */
  terminal?: SpawnTerminal;
}
