import { Popover } from "@base-ui/react/popover";
import { DEFAULT_CLAUDE_ACCOUNT, harnessCatalog, isHarnessId, type AllowanceWindow, type PlanLimits, type ProviderUsage } from "@openorc/protocol";
import { allowanceState, formatUsageTime, percentLeft, sessionWindow, usageResetLabel, weeklyWindow } from "@openorc/client";
import { useEffect, useState } from "react";
import { CoversPreview } from "../lib/browser-preview";
import { cn } from "../lib/cn";
import { useRpc } from "../lib/client";
import { useRouter } from "../lib/router";
import { floatingGround } from "../lib/use-anchor-ground";
import { HarnessLogo } from "./HarnessLogo";

type UsageAccount = { provider: ProviderUsage["provider"]; claudeAccountId?: string; name: string };

/**
 * The account the open thread runs on: its Claude account, or its agent's own. None off a thread, and none for a team
 * conversation, whose members can each run on their own account.
 */
function useThreadAccount(): UsageAccount | null {
  const threadId = useRouter((s) => (s.route.view === "thread" ? s.route.threadId : null));
  const thread = useRpc("threads.get", { id: threadId ?? "" }, { enabled: Boolean(threadId) }).data;
  const accounts = useRpc("claude.accounts.list", {}, { enabled: thread?.agent === "claude" }).data;
  if (!threadId || !thread || thread.id !== threadId || thread.teamInstanceId) return null;
  if (!isHarnessId(thread.agent)) return null;
  if (thread.agent !== "claude") return { provider: thread.agent, name: harnessCatalog[thread.agent].name };
  const id = thread.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT;
  return { provider: "claude", claudeAccountId: id, name: `Claude · ${accounts?.accounts.find((account) => account.id === id)?.name ?? "Existing CLI login"}` };
}

/** The id `providers.limits` gives an account: "codex", or "claude:" and the Claude account's id. */
function limitsId(account: UsageAccount): string {
  return account.provider === "claude" ? `claude:${account.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT}` : account.provider;
}

/** A small ring for the share that is left. */
function LeftRing({ left, className }: { left: number; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cn("account-usage-ring", className)} aria-hidden="true">
      <circle cx="8" cy="8" r="6" className="account-usage-track" />
      {left > 0 ? <circle cx="8" cy="8" r="6" className="account-usage-fill" pathLength="100" strokeDasharray={`${Math.min(100, left)} 100`} transform="rotate(-90 8 8)" /> : null}
    </svg>
  );
}

const emptyWords: Record<PlanLimits["status"], string> = {
  available: "No limits reported",
  unavailable: "No limits reported",
  disconnected: "Not signed in",
  error: "Couldn’t read usage",
};

/** Amber for an exhausted or out-of-date limit, and for one nearly used up. */
function limitTone(window: AllowanceWindow, shown: number, now: number): "warn" | "low" | undefined {
  if (window.exhausted || allowanceState(window, now).stale) return "warn";
  return shown <= 10 ? "low" : undefined;
}

function noteWords(failed: boolean, answered: boolean): string {
  if (failed) return "Couldn’t read usage";
  return answered ? "No limits reported" : "Reading usage";
}

function resetWords(window: AllowanceWindow, now: number): string {
  if (allowanceState(window, now).stale) return "Out of date";
  if (window.resetsAt === null) return "";
  return usageResetLabel(window.resetsAt, now).replace(/^Resets /, "");
}

/** One limit in the table: a ring and the share left, with when it resets under them. */
function LimitCell({ window, now }: { window: AllowanceWindow | null; now: number }) {
  const left = window ? percentLeft(window) : null;
  if (!window || left === null)
    return (
      <td className="usage-table-cell" data-empty>
        Not reported
      </td>
    );
  const shown = Math.round(left);
  const reset = resetWords(window, now);
  const tone = limitTone(window, shown, now);
  return (
    <td className="usage-table-cell" data-tone={tone} title={window.resetsAt === null ? undefined : formatUsageTime(window.resetsAt)}>
      <span className="usage-table-limit">
        <LeftRing left={left} />
        <span className="usage-table-value tabular">{shown}% left</span>
        {reset ? <span className="usage-table-reset">{reset}</span> : null}
      </span>
    </td>
  );
}

/** Every account's 5-hour and weekly limits in one table, the open thread's account first and marked. */
function UsageTable({ current }: { current: string }) {
  const read = useRpc("providers.limits", {}, { staleTime: 60_000 });
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const accounts = [...(read.data ?? [])].sort((a, b) => Number(b.id === current) - Number(a.id === current));
  return (
    <div className="usage-table-wrap">
      {accounts.length ? (
        <table className="usage-table">
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col">5 hours</th>
              <th scope="col">Week</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr key={account.id} data-current={account.id === current || undefined} aria-current={account.id === current || undefined}>
                <th scope="row">
                  <span className="usage-table-account">
                    <HarnessLogo id={account.provider} size={16} className="shrink-0" />
                    <span className="usage-table-name">
                      <span className="truncate">{account.name}</span>
                      {account.plan ? <span className="usage-table-plan">{account.plan}</span> : null}
                    </span>
                  </span>
                </th>
                {account.windows.length ? (
                  <>
                    <LimitCell window={sessionWindow(account.windows)} now={now} />
                    <LimitCell window={weeklyWindow(account.windows)} now={now} />
                  </>
                ) : (
                  <td className="usage-table-cell" data-empty colSpan={2}>
                    {emptyWords[account.status]}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="usage-table-note" role="status">
          {noteWords(read.isError, read.data !== undefined)}
        </p>
      )}
      <button type="button" className="usage-table-more no-drag" onClick={() => useRouter.getState().navigate({ view: "settings", section: "usage" })}>
        Usage in Settings
      </button>
    </div>
  );
}

/**
 * What is left of the open thread's account this week, above the sidebar's dock. It opens a table of every account's
 * limits out of the chip, the way the composer's pickers open out of theirs. Accounts without a weekly limit show nothing.
 */
export function AccountUsage() {
  const account = useThreadAccount();
  const usage = useRpc(
    "providers.usage",
    { provider: account?.provider ?? "claude", ...(account?.claudeAccountId ? { claudeAccountId: account.claudeAccountId } : {}) },
    { enabled: Boolean(account), staleTime: 60_000 },
  );
  const week = account && usage.data ? weeklyWindow(usage.data.windows) : null;
  const left = week ? percentLeft(week) : null;
  if (!account || !week || left === null) return null;
  const shown = Math.round(left);
  return (
    <Popover.Root>
      <Popover.Trigger className="account-usage-chip no-drag" data-low={shown <= 10 || undefined} aria-label={`${account.name}: ${shown}% left this week`}>
        <LeftRing left={left} />
        <span className="account-usage-value tabular">{shown}%</span>
        <span className="account-usage-label">left this week</span>
      </Popover.Trigger>
      <Popover.Portal>
        <CoversPreview />
        <Popover.Positioner side="top" align="start" sideOffset={6} collisionPadding={8} className="z-50">
          <Popover.Popup ref={floatingGround} className="floating-popover account-usage-popup" aria-label="Usage">
            <UsageTable current={limitsId(account)} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
