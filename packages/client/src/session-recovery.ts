import { DEFAULT_CLAUDE_ACCOUNT, type ClaudeAccountConnection, type ThreadSummary } from "@openorc/protocol";
import { projectAccountChoice, type AccountsProject } from "./project-claude-accounts.js";

/** What a conversation says to go on with another account, which resumes its session there. */
export const CONTINUE_PROMPT = "Continue where you left off.";
/** What a conversation says to go on in a fresh session, which knows nothing of the files since the handoff. */
export const RESTART_PROMPT = "Continue where you left off. Check the working tree first.";

type Recovering = Pick<ThreadSummary, "agent" | "orclingId" | "session">;

/**
 * Whether a stopped Claude turn can go on with another account: its own reached a usage limit or was signed out, both of
 * which only that account suffers. An Orcling speaks on its own.
 */
export function canContinueWithAnother({ agent, orclingId, session }: Recovering): boolean {
  return session.status === "error" && agent === "claude" && !orclingId && session.recovery?.provider === "claude";
}

/**
 * The signed-in Claude accounts a stopped turn can go on with: every one but its own, of those its project uses when it
 * uses only some.
 */
export function accountsToContinueWith(
  thread: Recovering & Pick<ThreadSummary, "claudeAccountId">,
  accounts: readonly ClaudeAccountConnection[],
  project?: AccountsProject | null,
): ClaudeAccountConnection[] {
  if (!canContinueWithAnother(thread)) return [];
  const current = thread.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT;
  const usable = projectAccountChoice(project, { accounts: [...accounts], defaultId: DEFAULT_CLAUDE_ACCOUNT }).accounts;
  return usable.filter((account) => account.id !== current && account.status === "ready");
}
