import { sessionWindow, weeklyWindow, type AllowanceWindow, type ProviderCredit } from "@openorc/protocol";
import type { UsageAccountReport } from "./account-usage-data";

/** What one cell of the usage table holds: a limit's share left, or a balance. A caption names a limit its column's head does not. */
export type UsageAmount = { limit: AllowanceWindow; caption?: string } | { credit: ProviderCredit };

/**
 * One row of the usage table: an account, or one pool of its models, with the amounts of its cells, two at most. A
 * null cell is a limit the account does not report, and a row with no cells has only its account's state to say. A row
 * that continues the one above it (`more`) holds the amounts that did not fit there.
 */
export interface UsageRow {
  account: UsageAccountReport;
  key: string;
  detail: string;
  cells: (UsageAmount | null)[];
  /** Its cells are the 5-hour and weekly limits, which the table's heads name. */
  headed: boolean;
  more: boolean;
}

/** A sign-in that is gone or could not be read has no connection to name. */
const unread = (account: UsageAccountReport) => account.status === "disconnected" || account.status === "error";

/**
 * The amounts one pool of an account's models holds, in order, and whether its first two are the 5-hour and weekly
 * limits. fx also reports budgets and balances, which are neither: they follow, each under its own name, the balances
 * with the account's first pool.
 */
function poolAmounts(account: UsageAccountReport, windows: AllowanceWindow[], first: boolean): { amounts: (UsageAmount | null)[]; headed: boolean } {
  const fx = account.provider === "fx";
  const session = sessionWindow(windows);
  const week = weeklyWindow(windows);
  const headed = Boolean(session || week) || (!fx && windows.length > 0);
  const limits = headed ? [session && { limit: session }, week && { limit: week }] : [];
  if (!fx) return { amounts: limits, headed };
  const budgets = windows.filter((window) => window !== session && window !== week).map((limit) => ({ limit, caption: limit.label }));
  const balances = first ? account.credits.map((credit) => ({ credit })) : [];
  return { amounts: [...limits, ...budgets, ...balances], headed };
}

/**
 * Every account as rows of one table, two amounts to a row. Separate model pools get their own row, so one pool never
 * stands in for the others, and amounts past a row's two carry on in the rows under it.
 */
export function usageRows(accounts: UsageAccountReport[]): UsageRow[] {
  return accounts.flatMap((account) => {
    const pools = new Map<string, AllowanceWindow[]>();
    for (const window of account.windows) pools.set(window.group ?? "", [...(pools.get(window.group ?? "") ?? []), window]);
    if (!pools.size) pools.set("", []);
    const connection = account.provider === "fx" && !unread(account) ? account.context : null;
    return [...pools].flatMap(([pool, windows], index) => {
      const { amounts, headed } = poolAmounts(account, windows, index === 0);
      const detail = [connection, account.plan, pool].filter(Boolean).join(" · ");
      const rows: UsageRow[] = [{ account, key: JSON.stringify([account.id, pool]), detail, cells: amounts.slice(0, 2), headed, more: false }];
      for (let at = 2; at < amounts.length; at += 2) rows.push({ account, key: JSON.stringify([account.id, pool, at]), detail: "", cells: amounts.slice(at, at + 2), headed: false, more: true });
      return rows;
    });
  });
}
