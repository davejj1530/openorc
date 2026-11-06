import { allowanceState, percentLeft } from "@openorc/client";
import type { ClaudeAccountConnection, PlanLimits } from "@openorc/protocol";

/** An account a stopped turn could go on with, and how much of its plan is left, as far as the last report says. */
export interface ContinueChoice {
  account: ClaudeAccountConnection;
  /** The share left of its tightest limit; null until a report says, or once the report is out of date. */
  left: number | null;
  /** When its reached limit resets; a report that reached one and is still current is the only thing that rules it out. */
  limited: { resetsAt: number | null } | null;
}

function choiceFor(account: ClaudeAccountConnection, limits: PlanLimits | undefined, now: number): ContinueChoice {
  const current = (limits?.windows ?? []).filter((window) => !allowanceState(window, now).stale);
  const reached = current.filter((window) => window.exhausted);
  const shares = current.flatMap((window) => percentLeft(window) ?? []);
  return {
    account,
    left: shares.length ? Math.min(...shares) : null,
    limited: reached.length ? { resetsAt: Math.max(...reached.map((window) => window.resetsAt ?? 0)) || null } : null,
  };
}

/** Most worth trying first: the most left, then those no report speaks for, then the ones at a limit. */
const rank = ({ left, limited }: ContinueChoice) => (limited ? -2 : (left ?? -1));

/** The accounts as a person would try them. `limits` is the host's `providers.limits`, empty until it answers. */
export function continueChoices(accounts: readonly ClaudeAccountConnection[], limits: readonly PlanLimits[], now: number): ContinueChoice[] {
  return accounts
    .map((account) =>
      choiceFor(
        account,
        limits.find((each) => each.id === `claude:${account.id}`),
        now,
      ),
    )
    .sort((a, b) => rank(b) - rank(a));
}
