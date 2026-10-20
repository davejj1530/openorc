import { Popover } from "@base-ui/react/popover";
import { DEFAULT_CLAUDE_ACCOUNT, harnessCatalog, isHarnessId, type ProviderUsage } from "@openorc/protocol";
import { CoversPreview } from "../lib/browser-preview";
import { percentLeft, weeklyWindow } from "../lib/provider-usage";
import { useRpc } from "../lib/query";
import { useRouter } from "../lib/router";
import { floatingGround } from "../lib/use-anchor-ground";
import { ProviderReport } from "../views/settings-usage";

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

/** A small ring for the share of the week that is left. */
function WeekRing({ left }: { left: number }) {
  return (
    <svg viewBox="0 0 16 16" className="account-usage-ring" aria-hidden="true">
      <circle cx="8" cy="8" r="6" className="account-usage-track" />
      {left > 0 ? <circle cx="8" cy="8" r="6" className="account-usage-fill" pathLength="100" strokeDasharray={`${Math.min(100, left)} 100`} transform="rotate(-90 8 8)" /> : null}
    </svg>
  );
}

/**
 * What is left of the open thread's account this week, by Settings. It opens the account's usage card out of the
 * chip, the way the composer's pickers open out of theirs. Accounts without a weekly limit show nothing.
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
        <WeekRing left={left} />
        <span className="account-usage-value tabular">{shown}%</span>
        <span className="account-usage-label">left this week</span>
      </Popover.Trigger>
      <Popover.Portal>
        <CoversPreview />
        <Popover.Positioner side="top" align="start" sideOffset={6} collisionPadding={8} className="z-50">
          <Popover.Popup ref={floatingGround} className="floating-popover account-usage-popup">
            <ProviderReport provider={account.provider} claudeAccountId={account.claudeAccountId} name={account.name} active now={Date.now()} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
