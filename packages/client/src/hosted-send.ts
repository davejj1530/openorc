import {
  harnessCatalog,
  harnessShortName,
  HOSTED_AGENTS,
  hostedSendBlock,
  isHostedAgent,
  payBlock,
  placeOf,
  sendBlockWords,
  type AccountStatus,
  type BillingOffers,
  type BillingPage,
  type SendBlockWhy,
  type ThreadSummary,
} from "@openorc/protocol";
import { cloudTime, priceText } from "./account-words.js";
import { rowStarter } from "./thread-row.js";

/**
 * Where the card above a cloud thread's composer leads: the Settings section that holds what is missing. Paying's three
 * lead to the account, where the move of the same name is the one that stands out (`billingMoves`).
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
  awaiting_payment: { label: "Update payment", section: "account" },
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

/**
 * Why the asks a thread waits on can't be answered from here: its place can't be reached, or a teammate started it and
 * the person only reads it. Null when they can.
 */
export function asksBlocked(thread: Pick<ThreadSummary, "owner"> | null): string | null {
  const starter = thread ? rowStarter(thread) : null;
  return placeUnreachable(thread) ?? (starter ? `Only ${starter.first} can answer in ${starter.first}'s thread.` : null);
}

/** Why a thread takes no messages from this person now. Drafts stay on the device until they can be sent. */
export function sendsBlocked(thread: Pick<ThreadSummary, "owner"> | null): string | null {
  return placeUnreachable(thread) ?? threadReadOnlyReason(thread);
}

/** Why only the starter can change this thread. Reach does not change who may act. */
export function threadReadOnlyReason(thread: Pick<ThreadSummary, "owner"> | null): string | null {
  const starter = thread ? rowStarter(thread) : null;
  return starter ? `Only ${starter.first} can make changes in ${starter.first}'s thread.` : null;
}

/** Where a blocked place in a new thread's menu leads: the Settings section, or the project's row there, that fixes it. */
export type StartFix = SendBlockAction & { project?: string };

/**
 * Why a place cannot be chosen for a new thread now. `words` says why, on demand. The row ends in the way to the fix, or,
 * where nothing the person can do here fixes it, in `reason`: a few words that stand for the sentence.
 */
export type StartBlock = { words: string; fix: StartFix; reason?: never } | { words: string; fix: null; reason: string };

/** The blocks a send has too: they come first, as the server checks them first. */
const BEFORE_PROJECT: readonly SendBlockWhy[] = ["offline", "not_pro", "no_hours", "awaiting_payment"];

const RUNS = `OpenOrc Cloud runs ${new Intl.ListFormat("en", { type: "conjunction" }).format(HOSTED_AGENTS.map((agent) => harnessCatalog[agent].name))}.`;

/** A send's block as a new thread's. An agent's own sign-in is fixed by signing that agent in. */
function sendStartBlock(why: SendBlockWhy, agent: string): StartBlock {
  const words = sendBlockWords(why, agent);
  const action = ACTIONS[why];
  if (!action) return { words, fix: null, reason: "Can't be reached" };
  const signIn = why === "no_sign_in" || why === "signed_out";
  return { words, fix: { ...action, label: signIn ? `Sign ${harnessShortName(agent)} in` : action.label } };
}

/**
 * Whether a new thread's place menu offers OpenOrc Cloud, and why it cannot be chosen now. Offered to a person signed
 * in, or one whose session the server ended, and never to someone with no account. Blocked in the order the server
 * would refuse it: reach, plan and hours; then the project (no GitHub repository, one GitHub doesn't let OpenOrc read,
 * one not added yet); then the agent (one OpenOrc Cloud doesn't run, one not signed in there).
 */
export function hostedStart(account: AccountStatus | undefined, input: { projectId: string; agent: string; model: string | null }): { shown: boolean; blocked: StartBlock | null } {
  if (account?.state === "signed-out")
    return account.ended ? { shown: true, blocked: { words: "Your OpenOrc session ended.", fix: { label: "Sign in", section: "account" } } } : { shown: false, blocked: null };
  if (account?.state !== "signed-in") return { shown: false, blocked: null };
  const why = hostedSendBlock(account, input, false);
  if (why && BEFORE_PROJECT.includes(why)) return { shown: true, blocked: sendStartBlock(why, input.agent) };
  const project = projectBlock(account, input.projectId);
  if (project) return { shown: true, blocked: project };
  if (!isHostedAgent(input.agent)) return { shown: true, blocked: { words: RUNS, fix: null, reason: `Not with ${harnessShortName(input.agent)}` } };
  return { shown: true, blocked: why ? sendStartBlock(why, input.agent) : null };
}

/** Why this Mac project has no cloud project to start in yet, and its row in Settings > Cloud, where that is fixed. */
function projectBlock(account: Extract<AccountStatus, { state: "signed-in" }>, projectId: string): StartBlock | null {
  const project = account.projects.find((each) => each.projectId === projectId);
  if (!project) return { words: "This project has no GitHub repository.", fix: null, reason: "No GitHub repository" };
  if (project.cloud === "added") return null;
  const row = { section: "cloud" as const, project: projectId };
  if (project.cloud === "addable") return { words: `${project.repo} is not on OpenOrc Cloud yet.`, fix: { label: "Add this project", ...row } };
  const words = `GitHub doesn't let OpenOrc read ${project.repo} yet.`;
  return account.github?.configured === false ? { words, fix: null, reason: "No GitHub access" } : { words, fix: { label: "Connect GitHub", ...row } };
}

/** One way to pay in Settings > Account. `primary`: what the account lacks now, the move that stands out. */
export interface BillingMove {
  page: BillingPage["page"];
  label: string;
  primary: boolean;
  /** Why it cannot be made now, said on demand. */
  blocked: string | null;
}

/** The page that fixes each block paying fixes, under the card's own words for it. */
const FIXED_BY: Record<NonNullable<ReturnType<typeof payBlock>>, BillingPage["page"]> = { not_pro: "pro", no_hours: "hours", awaiting_payment: "billing" };

/**
 * The ways to pay, by the row they end: the plan's (Upgrade for a free person; billing, to change, cancel or fix a
 * payment, for Pro) and the hours' (Pro only), which names the pack and its price once the offers are known. The one
 * that fixes what the account lacks stands out, and a payment that failed stands out while Pro lasts out its grace.
 */
export function billingMoves(account: Extract<AccountStatus, { state: "signed-in" }>, offers?: BillingOffers | null): { plan: BillingMove; hours: BillingMove | null } {
  const blocked = account.reach === "live" ? null : sendBlockWords("offline", "");
  const lacks = payBlock(account);
  const fix = account.plan.pro && account.plan.standing === "grace" ? "billing" : lacks && FIXED_BY[lacks];
  const move = (page: BillingPage["page"], label: string): BillingMove => ({ page, label, primary: fix === page, blocked });
  if (!account.plan.pro) return { plan: move("pro", ACTIONS.not_pro!.label), hours: null };
  const pack = offers && `Buy ${cloudTime(offers.hours.seconds)}${offers.hours.price ? ` for ${priceText(offers.hours.price)}` : ""}`;
  return { plan: move("billing", fix === "billing" ? ACTIONS.awaiting_payment!.label : "Manage billing"), hours: move("hours", pack || ACTIONS.no_hours!.label) };
}
