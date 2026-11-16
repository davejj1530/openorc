import { z } from "zod";

/** The links of the chain a cloud turn needs, in the order the check lists them. */
export const CLOUD_CHECK_STEPS = ["server", "standing", "claude", "codex", "opencode", "github", "machine"] as const;
export type CloudCheckStep = (typeof CLOUD_CHECK_STEPS)[number];

/** One link as the check found it: still tried, working, broken with why, or not tried with why. */
export type CloudCheckLink = { step: CloudCheckStep; state: "running" | "ok" | "broken" | "unchecked"; words: string | null; ms: number | null };

/** A person's last check: when it started, where its test machine ran, its links, and the first broken one once done. */
export type CloudCheck = { id: string; startedAt: number; done: boolean; service: string; links: CloudCheckLink[]; broken: CloudCheckStep | null };

/** The last check, none before one; or no check where the server has none. */
export type CloudCheckState = { state: "ready"; check: CloudCheck | null } | { state: "unavailable" };

/** Window-only: the person's cloud check, read as it goes, and started. Its GitHub link is the space's. */
export const hostedCheckRpcParams = {
  "cloudCheck.read": z.object({}).strict(),
  "cloudCheck.start": z.object({ spaceId: z.string().min(1).max(200) }).strict(),
};
export interface HostedCheckRpcResults {
  "cloudCheck.read": CloudCheckState;
  "cloudCheck.start": CloudCheckState;
}
