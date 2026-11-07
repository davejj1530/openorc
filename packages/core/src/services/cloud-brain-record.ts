import type { CloudBrainPlace } from "@openorc/protocol";
import type { Sent } from "./cloud-brain-claude.js";
import type { BrainPlace } from "./cloud-brain-place.js";
import type { BrainProject } from "./cloud-brain-projects.js";
import type { SignInRecord } from "./cloud-brain-signins.js";
import type { ProtectedSecretStore } from "./extraction-credentials.js";

const storageError = "Cannot access protected storage for the cloud brain. Unlock your OS keychain and retry.";

/**
 * A move to the other service, as far as it got. Its threads come home, a new brain is set up beside this one in a
 * record of its own, the old one is removed, then one write swaps the records, and the threads go back.
 */
export interface BrainMoving {
  /** Where it moves to, in the team Settings has when it sets up there on Vercel. */
  to: CloudBrainPlace;
  /** home: threads come to this Mac; staging: the new brain is set up; swapping: the old one goes; back: threads go to the new one. */
  stage: "home" | "staging" | "swapping" | "back";
  /** The threads it brought to this Mac, which go back to the new brain. */
  threads: string[];
  /** From here on the record in the move's own store is this move's new brain, never one an earlier move left there. */
  staging?: true;
  /** From the swap until this Mac has let the old brain go: its link key, and whether phones were paired with it. */
  left?: { linkKey: string | null; phones: boolean };
}

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
    /** A move to the other service under way. */
    moving?: BrainMoving;
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
