import type { RunnerFile, SandboxProvider, VercelConnection } from "@openorc/cloud";
import type { TextEmbedder } from "@openorc/memory";
import type { BrowserHost, PreviewHost } from "@openorc/protocol";
import type { DeviceSystem } from "./devices/system.js";
import type { RemoteNetwork } from "./remote/remote-access.js";
import type { BrainDoors } from "./services/cloud-brain-door.js";
import type { BrainBundleSource, OpenBrainMachine } from "./services/cloud-brain.js";
import type { BrainChannel, CoordinatorDeps } from "./services/relocation-coordinator.js";
import type { BrainEndpoint } from "./services/brain-link.js";
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
  /** Whether someone is using the Mac, asked once per alert. Without it, the Mac always reads as away. */
  presence?: () => Promise<boolean>;
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
  /** Serves the bench.* methods, which stream synthetic events and write a synthetic thread into the ledger. Development and QA builds only. */
  benchmarks?: boolean;
  /**
   * How the Device panel's helpers run processes. Tests pass a fake, so no simulator tool or hub ever runs. Null on a
   * machine with no simulators or emulators: nothing runs and agents have no device tool.
   */
  deviceSystem?: DeviceSystem | null;
  /** Where cloud conversations run. Defaults to sandboxes simulated in folders under `dataDir` on this Mac. */
  cloudSandboxes?: SandboxProvider;
  /** The cloud runner's source files, for a bundled core that cannot read them beside its own code. */
  cloudRunnerFiles?: RunnerFile[];
  /** Keeps the Vercel connection cloud threads run on. Without it, cloud threads run only in sandboxes on this Mac. */
  cloudSecrets?: ProtectedSecretStore;
  /** Keeps each Claude account's token for signing in to cloud sandboxes. */
  claudeCloudSecrets?: ProtectedSecretStore;
  /** Cloud threads are offered in this build; a paired phone offers them when the Mac does. */
  cloudOffered?: boolean;
  /**
   * Every conversation runs in a cloud sandbox and no agent starts on this machine, as on the cloud brain, whose process
   * holds the key to its secrets. Project conversations start in the cloud whatever the request says, Workspace and
   * checkout conversations are refused, there are no sandboxes simulated in folders, and nothing is offered: there is no
   * place to choose. An account's cloud token is its sign-in here. Background text generation still runs here.
   */
  cloudOnly?: boolean;
  /** Keeps the Codex login cloud sandboxes use, separate from this Mac's own. */
  codexCloudSecrets?: ProtectedSecretStore;
  /** Starts a command in a terminal of its own, for CLIs whose sign-in screens need one. Without it they get pipes. */
  terminal?: SpawnTerminal;
  /** Overrides the credentials Settings keeps, for tests and smoke scripts. While it resolves to null, new cloud conversations run in sandboxes on this Mac. */
  cloudCredentials?: () => Promise<VercelConnection | null>;
  /** Keeps the cloud brain's key, team and region. Losing it loses the brain: only its key opens the brain's secrets. */
  cloudBrainSecrets?: ProtectedSecretStore;
  /** The cloud brain this build installs, looked up when Settings asks. Without one, no brain can be set up. */
  cloudBrainBundle?: () => Promise<BrainBundleSource | null>;
  /** Reaches the cloud brain's machine in place of Vercel, for tests. */
  cloudBrainMachine?: OpenBrainMachine;
  /** Reaches the cloud brain's door in place of Vercel, for tests. */
  cloudBrainDoors?: BrainDoors;
  /** Reaches a cloud brain for moving threads in place of CloudBrain, for tests. */
  brainChannel?: BrainChannel;
  /** Dials a cloud brain for the windows in place of CloudBrain's, for tests. */
  brainEndpoint?: BrainEndpoint;
  /** For tests: how soon a move asks an unreachable brain again, and a hook after each of its steps. */
  relocationTiming?: Pick<CoordinatorDeps, "retryMs" | "step">;
}
