import { Popover } from "@base-ui/react/popover";
import {
  DEFAULT_CLAUDE_ACCOUNT,
  harnessCatalog,
  isHarnessId,
  type HarnessId,
  percentLeft,
  sessionWindow,
  weeklyWindow,
  type AllowanceWindow,
  type ProviderUsage,
  type ThreadSummary,
} from "@openorc/protocol";
import { allowanceState, cloudAccountChoices, conversationCost, creditBalanceLabel, formatCost, formatUsageTime, usageResetLabel } from "@openorc/client";
import { useEffect, useState, type ReactNode } from "react";
import { CoversPreview } from "../lib/browser-preview";
import { useRpc } from "../lib/client";
import { useUsageAccounts, usageAccountId, usageParams, USAGE_MAX_AGE_MS, type UsageAccount, type UsageAccountReport } from "../lib/account-usage-data";
import { savedComposerAccount, useComposerAccount, type ComposerAccount } from "../lib/composer-account";
import { useRouter } from "../lib/router";
import { floatingGround } from "../lib/use-anchor-ground";
import { HarnessLogo } from "./HarnessLogo";
import { AmountShare } from "./ContextUsage";
import { Signal } from "./icons";
import { Tooltip } from "./ui";

/** The footer's glyph size, the same as the sidebar's other tools. */
const USAGE_ICON = 16;

/** An agent and Claude account as the chip names them, or null for an agent OpenOrc does not run. */
function usageAccount(agent: string, claudeAccountId: string | undefined, accountName: (id: string) => string | undefined, model?: string | null): UsageAccount | null {
  if (!isHarnessId(agent)) return null;
  if (agent === "fx" && model?.includes("/")) return { provider: "fx", name: "fx", fxModel: model };
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
  if (!threadId) return composer ? usageAccount(composer.agent, composer.claudeAccountId, accountName, composer.model) : null;
  if (!thread || thread.id !== threadId || thread.teamInstanceId) return null;
  return usageAccount(thread.agent, thread.claudeAccountId ?? undefined, accountName, thread.model);
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

const emptyWords: Record<UsageAccountReport["status"], string> = {
  loading: "Reading usage",
  available: "No limits reported",
  unavailable: "No limits reported",
  disconnected: "Not signed in",
  error: "Couldn’t read usage",
};

/** The time a reading of OpenOrc Cloud's was taken, as its cell states it. */
const reportedAt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * Whether a limit's reading is out of date: this Mac's once it is older than its rule allows. A reading of OpenOrc
 * Cloud's (`turnRead`) comes only from a turn on its account, so it is never out of date by age, only when the last
 * read of it failed or the account is signed out.
 */
function outOfDate(window: AllowanceWindow, now: number, turnRead: TurnRead): boolean {
  return turnRead ? turnRead.failed : allowanceState(window, now).stale;
}

/** A reading of OpenOrc Cloud's, taken on the account's turns, and whether its last read failed or found it signed out. */
type TurnRead = { failed: boolean } | null;

/** Amber for an exhausted or out-of-date limit, and for one nearly used up. */
function limitTone(window: AllowanceWindow, shown: number, stale: boolean): "warn" | "low" | undefined {
  if (window.exhausted || stale) return "warn";
  return shown <= 10 ? "low" : undefined;
}

function noteWords(failed: boolean, answered: boolean): string {
  if (failed) return "Couldn’t read usage";
  return answered ? "No limits reported" : "Reading usage";
}

/** Under a limit: out of date, when a reading of OpenOrc Cloud's was taken, or when it resets. */
function resetWords(window: AllowanceWindow, now: number, stale: boolean, turnRead: TurnRead): string {
  if (stale) return "Out of date";
  if (turnRead) return `Reported ${reportedAt.format(window.observedAt)}`;
  if (window.resetsAt === null) return "";
  return usageResetLabel(window.resetsAt, now).replace(/^Resets /, "");
}

/** One limit in the table: a ring and the share left, with when it resets, or for OpenOrc Cloud when it was read, under them. */
function LimitCell({ window, now, turnRead }: { window: AllowanceWindow | null; now: number; turnRead: TurnRead }) {
  const left = window ? percentLeft(window) : null;
  if (!window || left === null)
    return (
      <td className="usage-table-cell" data-empty>
        Not reported
      </td>
    );
  const shown = Math.round(left);
  const stale = outOfDate(window, now, turnRead);
  const reset = resetWords(window, now, stale, turnRead);
  const tone = limitTone(window, shown, stale);
  return (
    <td className="usage-table-cell" data-tone={tone} data-tip={window.resetsAt === null ? undefined : formatUsageTime(window.resetsAt)}>
      <span className="usage-table-limit">
        <AmountShare fraction={left / 100} size={USAGE_ICON} />
        <span className="usage-table-value tabular">{shown}% left</span>
        {reset ? <span className="usage-table-reset">{reset}</span> : null}
      </span>
    </td>
  );
}

/** A row's reading of OpenOrc Cloud's, failed when its last read did or found the account signed out; none for this Mac's. */
const readOf = (account: Pick<UsageAccountReport, "status">, turnRead: boolean): TurnRead => (turnRead ? { failed: account.status === "error" || account.status === "disconnected" } : null);

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
  const now = useNow();
  const accounts = read.accounts.filter((account) => account.provider !== "fx");
  const currentId = usageAccountId(current);
  return (
    <div className="usage-table-wrap">
      {read.accounts
        .filter((account) => account.provider === "fx")
        .map((account) => (
          <FxAccountUsage key={account.id} account={account} now={now} />
        ))}
      {accounts.length > 0 && <LimitsTable accounts={accounts} currentId={currentId} now={now} />}
      {read.accounts.length === 0 && (
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

/** The time a table's resets count from, moved on every half minute. */
export function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Accounts' 5-hour and weekly limits, a row for each pool, with the current account's marked. `turnRead`: OpenOrc Cloud's readings. */
function LimitsTable({ accounts, currentId, now, turnRead = false }: { accounts: UsageAccountReport[]; currentId: string; now: number; turnRead?: boolean }) {
  return (
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
                <LimitCell window={sessionWindow(account.windows)} now={now} turnRead={readOf(account, turnRead)} />
                <LimitCell window={weeklyWindow(account.windows)} now={now} turnRead={readOf(account, turnRead)} />
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
  );
}

/** fx connections report budgets and balances as well as rolling plan limits. */
function FxAccountUsage({ account, now }: { account: UsageAccountReport; now: number }) {
  return (
    <section className="usage-cost" aria-label="fx account usage" aria-busy={account.status === "loading"}>
      <div className="usage-table-account">
        <HarnessLogo id="fx" size={16} className="shrink-0" />
        <span className="usage-table-name">
          <span>fx</span>
          <span className="usage-table-plan">{[account.context, account.plan].filter(Boolean).join(" · ")}</span>
        </span>
      </div>
      {account.windows.map((window) => {
        const left = percentLeft(window);
        const stale = outOfDate(window, now, null);
        return (
          <div className="usage-cost-row" key={window.id}>
            <span className="usage-table-name">
              <span>{window.label}</span>
              <span className="usage-table-plan">{resetWords(window, now, stale, null)}</span>
            </span>
            <span className="usage-table-limit" data-tone={left === null ? undefined : limitTone(window, left, stale)}>
              <AmountShare fraction={(left ?? 0) / 100} size={USAGE_ICON} />
              <span className="usage-cost-value tabular">{left === null ? "Not reported" : `${Math.round(left)}% left`}</span>
            </span>
          </div>
        );
      })}
      {account.credits.map((credit, index) => (
        <div className="usage-cost-row" key={`${credit.label}:${index}`}>
          <span>{credit.label}</span>
          <span className="usage-cost-value tabular">{creditBalanceLabel(credit)}</span>
        </div>
      ))}
      {((!account.windows.length && !account.credits.length) || account.status === "error" || account.status === "disconnected") && <p className="usage-cost-note">{emptyWords[account.status]}</p>}
    </section>
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

/** What the footer's usage button shows and says. */
interface UsageMark {
  tooltip: string;
  label: string;
  low: boolean;
  mark: ReactNode;
}

/** A share left as the foot shows it: filled on its disc, then the number. */
function ShareLeft({ left }: { left: number }) {
  return (
    <>
      <AmountShare fraction={left / 100} size={USAGE_ICON} />
      <span className="tabular">{Math.round(left)}%</span>
    </>
  );
}

/** The week's share left. */
function weekMark(account: UsageAccount, left: number): UsageMark {
  const shown = Math.round(left);
  return { tooltip: `${shown}% left this week`, label: `${account.name}: ${shown}% left this week`, low: shown <= 10, mark: <ShareLeft left={left} /> };
}

/** An account with no weekly limit has nothing to measure: the plain glyph, like the footer's other buttons, opening on what the conversation has cost. */
function noLimitMark(account: UsageAccount): UsageMark {
  return { tooltip: "No weekly limit", label: `${account.name}: no weekly limit`, low: false, mark: <Signal size={USAGE_ICON} /> };
}

function fxMark(account: UsageAccount, windows: AllowanceWindow[], credits: UsageAccountReport["credits"]): UsageMark | null {
  const primary = windows.filter((window) => window.group === windows[0]?.group);
  const window = weeklyWindow(primary) ?? sessionWindow(primary) ?? primary.find((window) => percentLeft(window) !== null);
  if (window) {
    const left = percentLeft(window)!;
    const tooltip = `${Math.round(left)}% left · ${window.label}`;
    return { tooltip, label: `${account.name}: ${tooltip}`, low: left <= 10, mark: <ShareLeft left={left} /> };
  }
  const credit = credits.find((credit) => credit.unlimited || credit.balance !== null);
  if (!credit) return null;
  const tooltip = `${credit.label}: ${creditBalanceLabel(credit)}`;
  return { tooltip, label: `fx: ${tooltip}`, low: !credit.unlimited && Number(credit.balance) <= 0, mark: <Signal size={USAGE_ICON} /> };
}

/** Where the table opens: over the sidebar's footer. */
const PLACE = { side: "top", align: "start", sideOffset: 8 } as const;

/**
 * Allowances and balances for the selected account, alongside reported conversation costs. On a cloud thread the
 * account is the agent sign-in its turns run on there; nothing is shown while the thread's place is still read.
 */
export function AccountUsage() {
  const place = useOpenThreadPlace();
  if (place === "reading") return null;
  return place === "mac" ? <LocalAccountUsage /> : <CloudAccountUsage agent={place.cloud} thread={place.thread} />;
}

/** Where the open thread runs: this Mac, off a thread too, or OpenOrc Cloud with the agent its turns run. */
function useOpenThreadPlace(): "reading" | "mac" | { cloud: HarnessId; thread: ThreadSummary } {
  const threadId = useRouter((state) => (state.route.view === "thread" ? state.route.threadId : null));
  const thread = useRpc("threads.get", { id: threadId ?? "" }, { enabled: Boolean(threadId) }).data;
  if (!threadId) return "mac";
  if (thread?.id !== threadId) return "reading";
  return thread.owner?.brain === "hosted" && isHarnessId(thread.agent) ? { cloud: thread.agent, thread } : "mac";
}

/**
 * The cloud thread's agent sign-in on OpenOrc Cloud, as the agent's CLI there last read it after one of the person's
 * turns: where the person keeps several accounts, the one the thread runs on for them. A reading grows out of date as
 * a reading here does; with none, nothing is shown.
 */
function CloudAccountUsage({ agent, thread }: { agent: HarnessId; thread: ThreadSummary }) {
  const status = useRpc("account.status", {}).data;
  const chosen = cloudAccountChoices(status, { agent, model: thread.model, accountId: thread.cloudAccountId });
  const named = chosen?.accounts.find((each) => each.id === chosen.current);
  const usage = useRpc("providers.usage", { provider: agent, cloud: true, ...(named && { cloudAccountId: named.id }) }, { staleTime: USAGE_MAX_AGE_MS });
  const now = useNow();
  // The agent is in the row's logo; its name says where the sign-in is, and which account where there are several.
  const account: UsageAccount = { provider: agent, name: named ? `OpenOrc Cloud · ${named.name}` : "OpenOrc Cloud" };
  const mark = accountMark(account, usage.data, null);
  if (!mark || !usage.data) return null;
  const report: UsageAccountReport = { ...account, id: agent, plan: usage.data.plan, windows: usage.data.windows, credits: usage.data.credits, context: usage.data.context, status: usage.data.status };
  return (
    <Popover.Root>
      <Tooltip label={mark.tooltip} side="top">
        <Popover.Trigger className="sidebar-tool account-usage-button no-drag" data-low={mark.low || undefined} aria-label={mark.label}>
          {mark.mark}
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <CoversPreview />
        <Popover.Positioner {...PLACE} collisionPadding={8} className="z-50">
          <Popover.Popup ref={floatingGround} className="floating-popover account-usage-popup" aria-label="Usage">
            <div className="usage-table-wrap">
              <LimitsTable accounts={[report]} currentId={report.id} now={now} turnRead />
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function LocalAccountUsage() {
  const account = useUsageAccount();
  const usage = useRpc("providers.usage", usageParams(account ?? { provider: "claude" }), { enabled: Boolean(account), staleTime: USAGE_MAX_AGE_MS });
  const cost = useConversationCost(account);
  if (!account) return null;
  const mark = accountMark(account, usage.data, cost);
  if (!mark) return null;
  return (
    <Popover.Root>
      <Tooltip label={mark.tooltip} side="top">
        <Popover.Trigger className="sidebar-tool account-usage-button no-drag" data-low={mark.low || undefined} aria-label={mark.label}>
          {mark.mark}
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

function accountMark(account: UsageAccount, report: ProviderUsage | undefined, cost: number | null): UsageMark | null {
  // Antigravity exposes Gemini to OpenOrc; its native CLI also reports a separate Claude/GPT pool.
  const windows = account.provider === "antigravity" ? report?.windows.filter((window) => window.id.startsWith("gemini-")) : report?.windows;
  const week = windows ? weeklyWindow(windows) : null;
  const left = week ? percentLeft(week) : null;
  let mark: UsageMark | null = null;
  if (account.provider === "fx") mark = fxMark(account, windows ?? [], report?.credits ?? []);
  else if (left !== null) mark = weekMark(account, left);
  if (!mark && cost !== null) mark = noLimitMark(account);
  return mark;
}
