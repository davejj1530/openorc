import { Popover } from "@base-ui/react/popover";
import { DEFAULT_CLAUDE_ACCOUNT, harnessCatalog, isHarnessId, percentLeft, sessionWindow, weeklyWindow, type AllowanceWindow } from "@openorc/protocol";
import { allowanceState, conversationCost, formatCost, formatUsageTime, usageResetLabel } from "@openorc/client";
import { useEffect, useState, type ReactNode } from "react";
import { CoversPreview } from "../lib/browser-preview";
import { cn } from "../lib/cn";
import { useRpc } from "../lib/client";
import { useUsageAccounts, usageAccountId, usageParams, USAGE_MAX_AGE_MS, type UsageAccount, type UsageAccountReport } from "../lib/account-usage-data";
import { savedComposerAccount, useComposerAccount, type ComposerAccount } from "../lib/composer-account";
import { useRouter } from "../lib/router";
import { floatingGround } from "../lib/use-anchor-ground";
import { HarnessLogo } from "./HarnessLogo";
import { Signal, SignalHigh, SignalLow, SignalMedium } from "./icons";
import { RAIL_ICON } from "./sidebar-screens";
import { Tooltip } from "./ui";

/** An agent and Claude account as the chip names them, or null for an agent OpenOrc does not run. */
function usageAccount(agent: string, claudeAccountId: string | undefined, accountName: (id: string) => string | undefined): UsageAccount | null {
  if (!isHarnessId(agent)) return null;
  if (agent !== "claude") return { provider: agent, name: harnessCatalog[agent].name };
  const id = claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT;
  return { provider: "claude", claudeAccountId: id, name: `Claude · ${accountName(id) ?? "Existing CLI login"}` };
}

/**
 * The account the chip reports on: on a thread, the one it runs on; anywhere else, the one the new-thread composer
 * has chosen, so the chip always shows the setup the next message would spend. None for a team conversation, whose
 * members can each run on their own account.
 */
function useUsageAccount(): UsageAccount | null {
  const threadId = useRouter((s) => (s.route.view === "thread" ? s.route.threadId : null));
  const thread = useRpc("threads.get", { id: threadId ?? "" }, { enabled: Boolean(threadId) }).data;
  const composer: ComposerAccount | null = useComposerAccount((s) => s.chosen) ?? (threadId ? null : savedComposerAccount());
  const agent = threadId ? thread?.agent : composer?.agent;
  const accounts = useRpc("claude.accounts.list", {}, { enabled: agent === "claude" }).data;
  const accountName = (id: string) => accounts?.accounts.find((account) => account.id === id)?.name;
  if (!threadId) return composer ? usageAccount(composer.agent, composer.claudeAccountId, accountName) : null;
  if (!thread || thread.id !== threadId || thread.teamInstanceId) return null;
  return usageAccount(thread.agent, thread.claudeAccountId ?? undefined, accountName);
}

/**
 * What the open conversation has cost, as its agent reported it, or null off a thread and before any report. Claude
 * Code prices every turn even on a plan, so its total is not what the account spent and is left out.
 */
function useConversationCost(account: UsageAccount | null): number | null {
  const threadId = useRouter((s) => (s.route.view === "thread" ? s.route.threadId : null));
  const priced = Boolean(threadId && account && account.provider !== "claude");
  const runs = useRpc("runs.listForThread", { threadId: threadId ?? "" }, { enabled: priced });
  return priced && runs.data ? conversationCost(runs.data) : null;
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

/** Settings' usage bars, from the fewest lit to all four. */
const LIT_BARS = [SignalLow, SignalMedium, SignalHigh, Signal] as const;

/** How many of the four bars a share left lights: one more for each quarter begun, none once nothing is left. */
function barsLit(left: number): number {
  if (left <= 0) return 0;
  return Math.min(4, Math.ceil(left / 25));
}

/** The share left as Settings' usage bars: the lit ones over all four on the track. */
function LeftBars({ left }: { left: number }) {
  const lit = barsLit(left);
  const Lit = lit ? LIT_BARS[lit - 1]! : null;
  return (
    <span className="account-usage-bars" aria-hidden="true">
      <Signal size={RAIL_ICON} className="account-usage-bars-track" />
      {Lit ? <Lit size={RAIL_ICON} className="account-usage-bars-fill" /> : null}
    </span>
  );
}

const emptyWords: Record<UsageAccountReport["status"], string> = {
  loading: "Reading usage",
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

/** Separate model pools get their own row, so one pool never stands in for the others. */
function usageRows(accounts: UsageAccountReport[]) {
  return accounts.flatMap((account) => {
    const groups = new Map<string, AllowanceWindow[]>();
    for (const window of account.windows) {
      const group = window.group ?? "";
      const windows = groups.get(group) ?? [];
      windows.push(window);
      groups.set(group, windows);
    }
    if (!groups.size) groups.set("", []);
    return [...groups].map(([group, windows]) => ({ ...account, windows, key: JSON.stringify([account.id, group]), detail: [account.plan, group].filter(Boolean).join(" · ") }));
  });
}

/** Every account's 5-hour and weekly limits in one table, the open thread's account first and marked. */
function UsageTable({ current }: { current: UsageAccount }) {
  const read = useUsageAccounts(current);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const accounts = read.accounts;
  const currentId = usageAccountId(current);
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
            {usageRows(accounts).map((account) => (
              <tr key={account.key} data-current={account.id === currentId || undefined} aria-current={account.id === currentId || undefined} aria-busy={account.status === "loading"}>
                <th scope="row">
                  <span className="usage-table-account">
                    <HarnessLogo id={account.provider} size={16} className="shrink-0" />
                    <span className="usage-table-name">
                      <span className="truncate">{account.name}</span>
                      {account.detail ? <span className="usage-table-plan">{account.detail}</span> : null}
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
          {noteWords(read.failed, !read.pending)}
        </p>
      )}
      {accounts.length > 0 && read.failed && (
        <p className="usage-table-note" role="status">
          Couldn’t load all accounts
        </p>
      )}
      <button type="button" className="usage-table-more no-drag" onClick={() => useRouter.getState().navigate({ view: "settings", section: "usage" })}>
        Usage in Settings
      </button>
    </div>
  );
}

/** The open conversation's cost, on the current row's fill above the table, with where the figure comes from. */
function ConversationCost({ account, cost }: { account: UsageAccount; cost: number }) {
  return (
    <section className="usage-cost" aria-label="This conversation">
      <div className="usage-cost-row">
        <span className="usage-table-account">
          <HarnessLogo id={account.provider} size={16} className="shrink-0" />
          <span className="usage-table-name">
            <span className="truncate">{account.name}</span>
            <span className="usage-table-plan">This conversation</span>
          </span>
        </span>
        <span className="usage-cost-value tabular">{formatCost(cost)}</span>
      </div>
      <p className="usage-cost-note">As {account.name} reports it after each turn.</p>
    </section>
  );
}

/** What the rail's button shows and says. */
interface RailMark {
  tooltip: string;
  label: string;
  low: boolean;
  mark: ReactNode;
}

/** The week's share left, as usage bars. */
function weekMark(account: UsageAccount, left: number): RailMark {
  const shown = Math.round(left);
  return { tooltip: `${shown}% left this week`, label: `${account.name}: ${shown}% left this week`, low: shown <= 10, mark: <LeftBars left={left} /> };
}

/** An account with no weekly limit has nothing to measure: the bars plain, like the rail's other buttons, opening on what the conversation has cost. */
function noLimitMark(account: UsageAccount): RailMark {
  return { tooltip: "No weekly limit", label: `${account.name}: no weekly limit`, low: false, mark: <Signal size={RAIL_ICON} /> };
}

/** Where the table opens: beside the rail's button. */
const PLACE = { side: "right", align: "end", sideOffset: 10 } as const;

/**
 * What is left this week of the account the next message would spend, as Settings' usage bars among the rail's
 * buttons, lit by the share left. It opens a table of every account's limits beside the rail. An account without a
 * weekly limit, such as OpenCode's provider accounts, shows the bars plain once its agent has reported what the open
 * conversation cost, and the popup leads with that cost; otherwise nothing.
 */
export function AccountUsage() {
  const account = useUsageAccount();
  const usage = useRpc("providers.usage", usageParams(account ?? { provider: "claude" }), { enabled: Boolean(account), staleTime: USAGE_MAX_AGE_MS });
  const cost = useConversationCost(account);
  // Antigravity exposes Gemini to OpenOrc; its native CLI also reports a separate Claude/GPT pool.
  const windows = account?.provider === "antigravity" ? usage.data?.windows.filter((window) => window.id.startsWith("gemini-")) : usage.data?.windows;
  const week = account && windows ? weeklyWindow(windows) : null;
  const left = week ? percentLeft(week) : null;
  if (!account) return null;
  let rail: RailMark | null = null;
  if (left !== null) rail = weekMark(account, left);
  else if (cost !== null) rail = noLimitMark(account);
  if (!rail) return null;
  return (
    <Popover.Root>
      <Tooltip label={rail.tooltip} side="right">
        <Popover.Trigger className="sidebar-dock-button account-usage-rail no-drag" data-low={rail.low || undefined} aria-label={rail.label}>
          {rail.mark}
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <CoversPreview />
        <Popover.Positioner {...PLACE} collisionPadding={8} className="z-50">
          <Popover.Popup ref={floatingGround} className="floating-popover account-usage-popup" aria-label="Usage">
            {cost !== null ? <ConversationCost account={account} cost={cost} /> : null}
            <UsageTable current={account} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
