import { hostedSendBlock, placeOf, sendBlockWords, type AccountStatus, type SendBlockWhy, type ThreadSummary } from "@openorc/protocol";

/**
 * Where the card above a cloud thread's composer leads: the Settings section that holds what is missing. Paying opens
 * nothing yet, so its three lead to the account, where the plan, its date and the hours left are.
 */
export interface SendBlockAction {
  label: string;
  section: "account" | "cloud";
}

/** Why a message to an OpenOrc Cloud thread cannot start a turn now, in words, with the way on. */
export interface SendBlock {
  why: SendBlockWhy;
  words: string;
  action: SendBlockAction | null;
}

const ACTIONS: Record<SendBlockWhy, SendBlockAction | null> = {
  offline: null,
  not_pro: { label: "Upgrade", section: "account" },
  no_hours: { label: "Buy more hours", section: "account" },
  awaiting_payment: { label: "Billing", section: "account" },
  no_sign_in: { label: "Sign in", section: "cloud" },
  signed_out: { label: "Sign in", section: "cloud" },
};

/**
 * The block on a thread's next send, derived once from the account as the app last heard it: null for a thread not on
 * OpenOrc Cloud, and for a send that can go. A message into a running turn is never blocked by hours or sign-ins, since
 * it runs on that turn's starter.
 */
export function threadSendBlock(thread: Pick<ThreadSummary, "owner" | "activity"> | null, account: AccountStatus | undefined, settings: { agent: string; model: string | null }): SendBlock | null {
  if (thread?.owner?.brain !== "hosted") return null;
  const why = hostedSendBlock(account, settings, thread.activity === "running");
  return why ? { why, words: sendBlockWords(why, settings.agent), action: ACTIONS[why] } : null;
}

/** Why nothing can be done to a thread now: its place can't be reached. Null when it can, and for this Mac's own threads. */
export function placeUnreachable(thread: Pick<ThreadSummary, "owner"> | null): string | null {
  return thread?.owner?.reach === "offline" ? `${placeOf(thread).mark ?? "This thread"} can't be reached.` : null;
}
