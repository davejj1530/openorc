import { z } from "zod";

/**
 * What a cloud thread started from this Mac's project folder would carry (cloud parity unit 5a), read before anything
 * leaves: the commits GitHub's copy of the base branch lacks, the changed and new files, the new files held back because
 * they look like secrets, and the packed size. `refusal` says why it can't go, naming the largest files.
 */
export type MacStartPlan =
  | {
      state: "ready";
      commits: { sha: string; subject: string }[];
      changed: string[];
      added: string[];
      held: string[];
      bytes: number;
      largest: { path: string; bytes: number }[];
      refusal: string | null;
    }
  /** The folder holds nothing GitHub lacks: the thread starts from GitHub as before. */
  | { state: "nothing" }
  /** No start from this Mac here: no account, the server without it, or a project not on OpenOrc Cloud. */
  | { state: "unavailable" };

/** Window-only: a paired phone never reads a Mac folder's work. */
export const hostedMacStartRpcParams = {
  "hostedMacStart.plan": z.object({ projectId: z.string().min(1), spaceId: z.string().optional(), include: z.array(z.string().min(1).max(1024)).max(200) }).strict(),
};
export interface HostedMacStartRpcResults {
  "hostedMacStart.plan": MacStartPlan;
}
