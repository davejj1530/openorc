import type { Sent } from "./cloud-brain-claude.js";
import type { BrainPlace } from "./cloud-brain-place.js";
import type { BrainProject } from "./cloud-brain-projects.js";
import type { SignInRecord } from "./cloud-brain-signins.js";
import type { ProtectedSecretStore } from "./extraction-credentials.js";

const storageError = "Cannot access protected storage for the cloud brain. Unlock your OS keychain and retry.";

/** Kept in protected storage. The key alone opens the brain's secrets, so it is saved before anything is made. */
export type StoredBrain = SignInRecord &
  BrainPlace & {
    key: string;
    /** The brain's public host, once it has started. */
    address: string | null;
    /** The brain has started once; until then setting up again keeps this key and place. */
    ready: boolean;
    claude: Sent[];
    /** The brain installed on its machine, as this Mac last installed or found it. Records from before lack it. */
    version?: string;
    /** The projects switched on for it. Records from before lack them. */
    projects?: BrainProject[];
    /** The brain's link key, learned at its first start, which this Mac dials it with. */
    linkKey?: string;
    /** The signInPrint of the agent CLI versions the brain last said it has, once they were this Mac's. */
    agentVersions?: string;
  };

/** The brain's record in protected storage, read once and kept. Losing it loses the brain: only its key opens the brain's secrets. */
export class BrainRecord {
  /** Undefined until read; null when no brain is set up. */
  private cache: StoredBrain | null | undefined;

  constructor(private readonly store: ProtectedSecretStore | undefined) {}

  /** What was read or written last, without reading. */
  get cached(): StoredBrain | null | undefined {
    return this.cache;
  }

  async read(): Promise<StoredBrain | null> {
    if (this.cache !== undefined) return this.cache;
    if (!this.store) return (this.cache = null);
    let raw: string | null;
    try {
      raw = await this.store.load();
    } catch {
      throw new Error(storageError);
    }
    try {
      this.cache = raw ? (JSON.parse(raw) as StoredBrain) : null;
    } catch {
      // JSON.parse's message quotes what it read, which holds the key.
      throw new Error(storageError);
    }
    return this.cache;
  }

  async write(next: StoredBrain | null): Promise<void> {
    try {
      if (!this.store) throw new Error(storageError);
      await this.store.save(next ? JSON.stringify(next) : "");
    } catch {
      throw new Error(storageError);
    }
    this.cache = next;
  }
}
