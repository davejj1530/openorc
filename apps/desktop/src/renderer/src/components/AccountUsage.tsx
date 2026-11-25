import { Popover } from "@base-ui/react/popover";
import { DEFAULT_CLAUDE_ACCOUNT, harnessCatalog, isHarnessId, type HarnessId, percentLeft, type AllowanceWindow, type ProviderUsage, type ThreadSummary } from "@openorc/protocol";
import { allowanceState, cloudAccountChoices, conversationCost, creditBalanceLabel, formatCost, formatUsageTime, usageMeter, usageResetLabel, type ModelChoice } from "@openorc/client";
import { useEffect, useState, type ReactNode } from "react";
import { CoversPreview } from "../lib/browser-preview";
import { useRpc } from "../lib/client";
import { useUsageAccounts, usageAccountId, usageParams, USAGE_MAX_AGE_MS, type UsageAccount, type UsageAccountReport } from "../lib/account-usage-data";
import { useClaudeAccountId } from "../lib/claude-account";
import { useRouter } from "../lib/router";
import { usageRows, type UsageAmount } from "../lib/usage-rows";
import { floatingGround } from "../lib/use-anchor-ground";
import { HarnessLogo } from "./HarnessLogo";
import { AmountShare } from "./ContextUsage";
import { Signal } from "./icons";
import { Tooltip } from "./ui";

/** A limit's disc in the table. */
const USAGE_ICON = 16;
/** The meter's disc in the model chip, the size of the chip's own marks. */
const MARK = 14;

/** An agent and Claude account as the chip names them, or null for an agent OpenOrc does not run. */
function usageAccount(agent: string, claudeAccountId: string | undefined, accountName: (id: string) => string | undefined, model?: string | null): UsageAccount | null {
  if (!isHarnessId(agent)) return null;
  if (agent === "fx" && model?.includes("/")) return { provider: "fx", name: "fx", fxModel: model };
  if (agent !== "claude") return { provider: agent, name: harnessCatalog[agent].name };
  const id = claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT;
  return { provider: "claude", claudeAccountId: id, name: `Claude · ${accountName(id) ?? "Existing CLI login"}` };
}

/**
 * The account the meter reports on: on a thread, the one it runs on; anywhere else, the one its model chip has chosen,
 * on the Claude account its composer works on, so the meter always shows the setup the next message would spend. None
 * for a team conversation, whose members can each run on their own account.
 */
function useUsageAccount(choice: ModelChoice | null): UsageAccount | null {
  const threadId = useRouter((s) => (s.route.view === "thread" ? s.route.threadId : null));
  const thread = useRpc("threads.get", { id: threadId ?? "" }, { enabled: Boolean(threadId) }).data;
  const scoped = useClaudeAccountId();
  const agent = threadId ? thread?.agent : choice?.agent;
  const accounts = useRpc("claude.accounts.list", {}, { enabled: agent === "claude" }).data;
  const accountName = (id: string) => accounts?.accounts.find((account) => account.id === id)?.name;
  if (!threadId) return choice ? usageAccount(choice.agent, scoped, accountName, choice.model) : null;
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

/**
 * Under a limit: out of date, or when it resets. A reading of OpenOrc Cloud's says when it was taken on its row, and a
 * reset already passed says nothing, since only a turn reads it again.
 */
function resetWords(window: AllowanceWindow, now: number, stale: boolean, turnRead: TurnRead): string {
  if (stale) return "Out of date";
  if (window.resetsAt === null || (turnRead && window.resetsAt <= now)) return "";
  return usageResetLabel(window.resetsAt, now).replace(/^Resets /, "");
}

/**
 * One amount in the table. A limit is its disc and the share left, over when it resets, or over its own name where the
 * column's head does not name it; a balance is its figure. A limit the account does not report says so, and a cell
 * past a row's amounts stays empty.
 */
function AmountCell({ amount, now, turnRead }: { amount: UsageAmount | null | undefined; now: number; turnRead: TurnRead }) {
  if (amount === undefined) return <td className="usage-table-cell" />;
  if (amount && "credit" in amount)
    return (
      <td className="usage-table-cell" data-tip={amount.credit.label}>
        <span className="usage-table-limit">
          <span className="usage-table-value tabular">{creditBalanceLabel(amount.credit)}</span>
          <span className="usage-table-reset">Balance</span>
        </span>
      </td>
    );
  const left = amount ? percentLeft(amount.limit) : null;
  if (!amount || left === null)
    return (
      <td className="usage-table-cell" data-empty>
        Not reported
      </td>
    );
  const window = amount.limit;
  const shown = Math.round(left);
  const stale = outOfDate(window, now, turnRead);
  const under = amount.caption && !stale ? amount.caption : resetWords(window, now, stale, turnRead);
  const tone = limitTone(window, shown, stale);
  return (
    <td className="usage-table-cell" data-tone={tone} data-tip={[amount.caption, window.resetsAt === null ? null : formatUsageTime(window.resetsAt)].filter(Boolean).join(" · ") || undefined}>
      <span className="usage-table-limit">
        <AmountShare fraction={left / 100} size={USAGE_ICON} />
        <span className="usage-table-value tabular">{shown}% left</span>
        {under ? <span className="usage-table-reset">{under}</span> : null}
      </span>
    </td>
  );
}

/** A row's reading of OpenOrc Cloud's, failed when its last read did or found the account signed out; none for this Mac's. */
const readOf = (account: Pick<UsageAccountReport, "status">, turnRead: boolean): TurnRead => (turnRead ? { failed: account.status === "error" || account.status === "disconnected" } : null);

/**
 * Every account's limits and balances in one table, the open thread's account first and marked. Under it, the way to
 * Usage in Settings and, once its agent reports one, what the open conversation has cost.
 */
function UsageTable({ current, cost }: { current: UsageAccount; cost: number | null }) {
  const read = useUsageAccounts(current);
  const now = useNow();
  return (
    <div className="usage-table-wrap">
      {read.accounts.length > 0 ? (
        <LimitsTable accounts={read.accounts} currentId={usageAccountId(current)} now={now} />
      ) : (
        <p className="usage-table-note" role="status">
          {noteWords(read.failed, !read.pending)}
        </p>
      )}
      {read.accounts.length > 0 && read.failed && (
        <p className="usage-table-note" role="status">
          Couldn’t load all accounts
        </p>
      )}
      <div className="usage-table-foot">
        <button type="button" className="usage-table-more no-drag" onClick={() => useRouter.getState().navigate({ view: "settings", section: "usage" })}>
          Usage in Settings
        </button>
        {cost !== null ? (
          <p className="usage-cost" data-tip={`As ${current.name} reports it after each turn.`}>
            This conversation <span className="usage-cost-value tabular">{formatCost(cost)}</span>
          </p>
        ) : null}
      </div>
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

/**
 * Accounts' limits and balances, a row for each account or pool of its models, with the current account's marked. The
 * heads name the 5-hour and weekly limits while some row holds them. `turnRead`: OpenOrc Cloud's readings.
 */
function LimitsTable({ accounts, currentId, now, turnRead = false }: { accounts: UsageAccountReport[]; currentId: string; now: number; turnRead?: boolean }) {
  const rows = usageRows(accounts);
  return (
    <table className="usage-table">
      <colgroup>
        <col />
        <col className="usage-table-amount" />
        <col className="usage-table-amount" />
      </colgroup>
      <thead>
        <tr>
          <th scope="col">Account</th>
          {rows.some((row) => row.headed) ? (
            <>
              <th scope="col">5 hours</th>
              <th scope="col">Week</th>
            </>
          ) : (
            <td colSpan={2} />
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map(({ account, key, detail, cells, more }) => {
          const current = account.id === currentId || undefined;
          const read = readOf(account, turnRead);
          return (
            <tr key={key} data-current={current} aria-current={current} aria-busy={account.status === "loading"} data-more={more || undefined}>
              <th scope="row">
                {more ? null : (
                  <span className="usage-table-account">
                    <HarnessLogo id={account.provider} size={16} className="shrink-0" />
                    <span className="usage-table-name">
                      <span className="truncate">{account.name}</span>
                      {detail ? <span className="usage-table-plan">{detail}</span> : null}
                    </span>
                  </span>
                )}
              </th>
              {cells.length ? (
                <>
                  <AmountCell amount={cells[0]} now={now} turnRead={read} />
                  <AmountCell amount={cells[1]} now={now} turnRead={read} />
                </>
              ) : (
                <td className="usage-table-cell" data-empty colSpan={2}>
                  {emptyWords[account.status]}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** What the model chip's meter shows and says. */
interface UsageMark {
  tooltip: string;
  label: string;
  low: boolean;
  mark: ReactNode;
}

/** Where the table opens: over the model chip, as the chip's own picker does. */
const PLACE = { side: "top", align: "start", sideOffset: 6 } as const;

/**
 * The model chip's meter: the week's share left on the account the chip's choice runs on, opening on every account's
 * allowances and balances alongside reported conversation costs. On a cloud thread the account is the agent sign-in
 * its turns run on there; nothing is shown while the thread's place is still read.
 */
export function AccountUsage({ choice }: { choice: ModelChoice | null }) {
  const place = useOpenThreadPlace();
  if (place === "reading") return null;
  return place === "mac" ? <LocalAccountUsage choice={choice} /> : <CloudAccountUsage agent={place.cloud} thread={place.thread} />;
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
  // In the table the logo says the agent and the row its account; under it, once, when the reading was taken.
  const reported = usage.data.refreshedAt === null ? usage.data.plan : `Reported ${reportedAt.format(usage.data.refreshedAt)}`;
  const report: UsageAccountReport = {
    ...account,
    name: named?.name ?? account.name,
    id: agent,
    plan: reported,
    windows: usage.data.windows,
    credits: usage.data.credits,
    context: usage.data.context,
    status: usage.data.status,
  };
  return (
    <Popover.Root>
      <Tooltip label={mark.tooltip} side="top">
        <Popover.Trigger className="composer-model-usage" data-low={mark.low || undefined} aria-label={mark.label}>
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

function LocalAccountUsage({ choice }: { choice: ModelChoice | null }) {
  const account = useUsageAccount(choice);
  const usage = useRpc("providers.usage", usageParams(account ?? { provider: "claude" }), { enabled: Boolean(account), staleTime: USAGE_MAX_AGE_MS });
  const cost = useConversationCost(account);
  if (!account) return null;
  const mark = accountMark(account, usage.data, cost);
  if (!mark) return null;
  return (
    <Popover.Root>
      <Tooltip label={mark.tooltip} side="top">
        <Popover.Trigger className="composer-model-usage" data-low={mark.low || undefined} aria-label={mark.label}>
          {mark.mark}
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <CoversPreview />
        <Popover.Positioner {...PLACE} collisionPadding={8} className="z-50">
          <Popover.Popup ref={floatingGround} className="floating-popover account-usage-popup" aria-label="Usage">
            <UsageTable current={account} cost={cost} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The meter as the chip draws it: the share left filled on its disc, or a plain glyph where there is none to measure. Its number is the meter's hover words. */
function accountMark(account: UsageAccount, report: ProviderUsage | undefined, cost: number | null): UsageMark | null {
  const meter = usageMeter(account, report, cost);
  if (!meter) return null;
  return { tooltip: meter.words, label: meter.label, low: meter.low, mark: meter.left === null ? <Signal size={MARK} /> : <AmountShare fraction={meter.left / 100} size={MARK} /> };
}
