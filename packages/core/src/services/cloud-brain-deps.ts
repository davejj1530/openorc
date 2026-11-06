import type { Agent37Connection, AgentVersions } from "@openorc/cloud";
import type { Db } from "@openorc/db";
import type { CloudService } from "@openorc/protocol";
import type { ClaudeCloudTokens } from "./claude-cloud-tokens.js";
import type { BrainDoors } from "./cloud-brain-door.js";
import type { BrainBundleSource, OpenBrainMachine } from "./cloud-brain-machine.js";
import type { BrainConnections } from "./cloud-brain-place.js";
import type { SignInSources } from "./cloud-brain-signins.js";
import type { UpdateWait } from "./cloud-brain-update.js";
import type { ProtectedSecretStore } from "./extraction-credentials.js";

/** What the cloud brain is made with: the ledger, protected storage, this Mac's connections and sign-ins. */
export interface CloudBrainDeps {
  db: Db;
  store: ProtectedSecretStore | undefined;
  tokens: Pick<ClaudeCloudTokens, "status" | "token">;
  /** The Vercel connection a brain on Vercel is made with. The brain keeps its own project on the team. */
  vercel: BrainConnections["vercel"];
  /** The Agent37 connection a brain on Agent37 is made with; none unless given. */
  agent37?: () => Promise<Agent37Connection | null>;
  /** The service a new brain is made on; Vercel while it is connected, unless given. */
  service?: () => Promise<CloudService | null>;
  bundle: (() => Promise<BrainBundleSource | null>) | undefined;
  changed: () => void;
  open?: OpenBrainMachine;
  doors?: BrainDoors;
  /** The brain's project and its door's; the product's own unless given, as for a QA brain kept apart. */
  projects?: { brain?: string; door?: string };
  /** This Mac's sign-ins besides Claude's that the brain is kept on; none unless given. */
  signIns?: SignInSources;
  /** This Mac's agent CLI versions, which the brain is brought to at each wake; none unless given. */
  agentVersions?: () => Promise<AgentVersions>;
  /** How long a wake waits for a busy brain to restart onto its update; a minute, asking every five seconds, unless given. */
  updateWait?: UpdateWait;
  /** Where its phones are kept; the brain's own unless given, as for one set up or removed beside it in a move. */
  phonesKey?: string;
}
