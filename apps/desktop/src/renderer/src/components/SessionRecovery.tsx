import { Menu } from "@base-ui/react/menu";
import { DEFAULT_CLAUDE_ACCOUNT, harnessShortName, type ClaudeAccountConnection, type ThreadSummary } from "@openorc/protocol";
import { CoversPreview } from "../lib/browser-preview";
import { useRpc } from "../lib/client";
import { floatingGround } from "../lib/use-anchor-ground";
import { AlertCircle, ChevronDown } from "./icons";
import { menuItem, menuPopup } from "./menu";
import { Button } from "./ui";

/**
 * A lost session or a failed last turn, with a fresh start that hands the conversation over. A turn stopped by a
 * Claude usage limit can go on with another signed-in account instead, which resumes the conversation's session.
 */
export function SessionRecovery({ thread, disabled, onRestart, onContinueWith }: { thread: ThreadSummary; disabled: boolean; onRestart: () => void; onContinueWith: (accountId: string) => void }) {
  const { session } = thread;
  const accounts = useAccountsToContinueWith(thread);
  if (session.status !== "lost" && session.status !== "error") return null;
  return (
    <div data-blocking="true" className="rounded-xl bg-bad-soft px-4 py-3 text-base">
      <div className="flex items-start gap-2.5">
        <AlertCircle size={16} className="text-bad mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1 grid gap-2">
          <div className="text-ink">{session.status === "lost" ? `${harnessShortName(thread.agent)} no longer has this session.` : "The last turn failed."}</div>
          {session.message ? <div className="text-ink-2 whitespace-pre-wrap break-words max-h-24 overflow-auto">{session.message}</div> : null}
          <div className="flex flex-wrap items-center gap-2">
            <ContinueWith accounts={accounts} disabled={disabled} onChoose={onContinueWith} />
            <Button size="sm" variant={accounts.length ? "secondary" : "primary"} disabled={disabled} onClick={onRestart}>
              {session.status === "lost" ? "Start a fresh session with a handoff" : "Retry with a fresh session"}
            </Button>
            {session.status === "error" ? <span className="text-xs text-ink-2">Or send a message to resume.</span> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The other signed-in Claude accounts, once the thread's own reached its usage limit. An Orcling speaks on its own. */
function useAccountsToContinueWith(thread: ThreadSummary): ClaudeAccountConnection[] {
  const { recovery } = thread.session;
  const limited = thread.session.status === "error" && thread.agent === "claude" && !thread.orclingId && recovery?.kind === "usage" && recovery.provider === "claude";
  const accounts = useRpc("claude.accounts.list", {}, { enabled: limited }).data;
  if (!limited || !accounts) return [];
  const current = thread.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT;
  return accounts.accounts.filter((account) => account.id !== current && account.status === "ready");
}

function ContinueWith({ accounts, disabled, onChoose }: { accounts: ClaudeAccountConnection[]; disabled: boolean; onChoose: (accountId: string) => void }) {
  const [only] = accounts;
  if (!only) return null;
  if (accounts.length === 1)
    return (
      <Button size="sm" variant="primary" disabled={disabled} onClick={() => onChoose(only.id)}>
        Continue with {only.name}
      </Button>
    );
  return (
    <Menu.Root>
      <Menu.Trigger render={<Button size="sm" variant="primary" />} disabled={disabled}>
        Continue with another account
        <ChevronDown size={14} />
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner sideOffset={4} align="start" collisionPadding={8}>
          <Menu.Popup ref={floatingGround} className={menuPopup}>
            {accounts.map((account) => (
              <Menu.Item key={account.id} className={menuItem} onClick={() => onChoose(account.id)}>
                {account.name}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
