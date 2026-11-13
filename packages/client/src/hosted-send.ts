import { harnessCatalog, HOSTED_AGENTS, hostedSendBlock, isHostedAgent, placeOf, sendBlockWords, type AccountStatus, type SendBlockWhy, type ThreadSummary } from "@openorc/protocol";

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

/** Why a new thread cannot start on OpenOrc Cloud, with the way to the Settings section, or project row, that fixes it. */
export interface StartBlock {
  words: string;
  action: (SendBlockAction & { project?: string }) | null;
}

/** The blocks a send has too: they come first, as the server checks them first. */
const BEFORE_PROJECT: readonly SendBlockWhy[] = ["offline", "not_pro", "no_hours", "awaiting_payment"];

const RUNS = `OpenOrc Cloud runs ${new Intl.ListFormat("en", { type: "conjunction" }).format(HOSTED_AGENTS.map((agent) => harnessCatalog[agent].name))}.`;

/**
 * Whether a new thread's place menu offers OpenOrc Cloud, and why it cannot be chosen now. Offered to a person signed
 * in, or one whose session the server ended, and never to someone with no account. Blocked in the order the server
 * would refuse it: reach, plan and hours; then the project (no GitHub repository, one GitHub doesn't let OpenOrc read,
 * one not added yet); then the agent (one OpenOrc Cloud doesn't run, one not signed in there).
 */
export function hostedStart(account: AccountStatus | undefined, input: { projectId: string; agent: string; model: string | null }): { shown: boolean; blocked: StartBlock | null } {
  if (account?.state === "signed-out")
    return account.ended ? { shown: true, blocked: { words: "Your OpenOrc session ended. Sign in again.", action: { label: "Sign in", section: "account" } } } : { shown: false, blocked: null };
  if (!account) return { shown: false, blocked: null };
  const why = hostedSendBlock(account, input, false);
  if (why && BEFORE_PROJECT.includes(why)) return { shown: true, blocked: { words: sendBlockWords(why, input.agent), action: ACTIONS[why] } };
  const project = projectBlock(account, input.projectId);
  if (project) return { shown: true, blocked: project };
  if (!isHostedAgent(input.agent)) return { shown: true, blocked: { words: RUNS, action: null } };
  return { shown: true, blocked: why ? { words: sendBlockWords(why, input.agent), action: ACTIONS[why] } : null };
}

/** Why this Mac project has no cloud project to start in yet, and its row in Settings > Cloud, where that is fixed. */
function projectBlock(account: Extract<AccountStatus, { state: "signed-in" }>, projectId: string): StartBlock | null {
  const project = account.projects.find((each) => each.projectId === projectId);
  if (!project) return { words: "This project has no GitHub repository.", action: null };
  if (project.cloud === "added") return null;
  const row = { section: "cloud" as const, project: projectId };
  if (project.cloud === "addable") return { words: `Add ${project.repo} to OpenOrc Cloud first.`, action: { label: "Add this project", ...row } };
  return { words: `GitHub doesn't let OpenOrc read ${project.repo} yet.`, action: account.github?.configured === false ? null : { label: "Connect GitHub", ...row } };
}
