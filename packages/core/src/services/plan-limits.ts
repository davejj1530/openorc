import { claudeAccounts, type Db } from "@openorc/db";
import type { AllowanceWindow, HarnessAvailability, PlanLimits, ProviderUsage } from "@openorc/protocol";
import type { ProviderUsageService } from "./provider-usage.js";

/**
 * How old a report a phone may be answered with. A phone reads its limits each time Settings opens and again after
 * every reconnect, and each fresh read starts the provider's CLI (Claude's takes about 4 s cold). The shares move
 * slowly and the desktop's own Usage view rereads after a minute too, so within one minute every phone, and the
 * desktop's last read, share one report per account.
 */
export const PLAN_LIMITS_MAX_AGE_MS = 60_000;

interface Sources {
  db: Db;
  usage: Pick<ProviderUsageService, "recent">;
  /** The Mac's harness checks, so a harness it does not have shows no card. */
  availability: () => Promise<readonly HarnessAvailability[]>;
}

type Account = Pick<PlanLimits, "id" | "provider" | "name"> & { read: () => Promise<ProviderUsage> };

/** Codex, then each enabled Claude account, each read on its own so one that fails is only that card's error. */
export async function readPlanLimits({ db, usage, availability }: Sources): Promise<PlanLimits[]> {
  const installed = new Set((await availability()).filter((row) => row.state !== "not_found").map((row) => row.id));
  const claude = installed.has("claude") ? claudeAccounts.list(db).filter((account) => account.enabled) : [];
  const accounts: Account[] = [
    ...(installed.has("codex") ? [{ id: "codex", provider: "codex" as const, name: "Codex", read: () => usage.recent("codex", undefined, PLAN_LIMITS_MAX_AGE_MS) }] : []),
    ...claude.map((account) => ({
      id: `claude:${account.id}`,
      provider: "claude" as const,
      name: claude.length > 1 ? `Claude · ${account.name}` : "Claude",
      read: () => usage.recent("claude", account.id, PLAN_LIMITS_MAX_AGE_MS),
    })),
  ];
  return Promise.all(
    accounts.map(({ read, ...account }) =>
      read().then(
        (report) => planLimits(account, report),
        (): PlanLimits => ({ ...account, plan: null, status: "error", windows: [], refreshedAt: null }),
      ),
    ),
  );
}

/** Field by field, so nothing a report gains later reaches a phone without being named here. */
function planLimits(account: Pick<PlanLimits, "id" | "provider" | "name">, report: ProviderUsage): PlanLimits {
  return {
    ...account,
    plan: report.plan,
    status: report.status,
    windows: report.windows.map((window) => limitWindow(window, account.provider, report.plan)),
    refreshedAt: report.refreshedAt,
  };
}

function limitWindow({ id, label, usedPercent, remainingPercent, resetsAt, observedAt, exhausted }: AllowanceWindow, provider: PlanLimits["provider"], plan: string | null): AllowanceWindow {
  return { id, label: windowLabel(label, provider, plan), usedPercent, remainingPercent, resetsAt, observedAt, exhausted };
}

/** Codex names its own bucket and plan before each window ("codex · pro · 5-hour window"); the card names both already. */
export function windowLabel(label: string, provider: PlanLimits["provider"], plan: string | null): string {
  const named = new Set([provider, plan?.toLowerCase()]);
  const parts = label.split(" · ");
  const first = parts.findIndex((part) => !named.has(part.toLowerCase()));
  return first > 0 ? parts.slice(first).join(" · ") : label;
}
