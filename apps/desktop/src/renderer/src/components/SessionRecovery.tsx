import { Menu } from "@base-ui/react/menu";
import { accountsToContinueWith, canContinueWithAnother, projectAccountChoice } from "@openorc/client";
import { harnessShortName, type ClaudeAccountConnection, type ThreadSummary } from "@openorc/protocol";
import { CoversPreview } from "../lib/browser-preview";
import { useRpc } from "../lib/client";
import { openProject } from "../lib/router";
import { floatingGround } from "../lib/use-anchor-ground";
import { AlertCircle, ChevronDown } from "./icons";
import { menuItem, menuPopup } from "./menu";
import { Button, TextButton } from "./ui";

/**
 * A lost session or a failed last turn, with a fresh start that hands the conversation over. A turn stopped by a
 * Claude usage limit can go on with another signed-in account instead, which resumes the conversation's session.
 */
export function SessionRecovery({ thread, disabled, onRestart, onContinueWith }: { thread: ThreadSummary; disabled: boolean; onRestart: () => void; onContinueWith: (accountId: string) => void }) {
  const { session } = thread;
  const { accounts, exhausted } = useAccountsToContinueWith(thread);
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
          {exhausted ? (
            <div className="text-xs text-ink-2">
              Every account this project uses is at its limit.{" "}
              <TextButton underline tone="strong" onClick={() => openProject(thread.projectId, "settings")}>
                Project accounts
              </TextButton>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The accounts the stopped turn can go on with, of those its project uses; `exhausted` when its usage limit stopped it,
 * the project uses only some accounts, and none of them is left to go on with. A signed-out account is not at its limit.
 */
function useAccountsToContinueWith(thread: ThreadSummary): { accounts: ClaudeAccountConnection[]; exhausted: boolean } {
  const offered = canContinueWithAnother(thread);
  const list = useRpc("claude.accounts.list", {}, { enabled: offered }).data;
  const project = useRpc("projects.get", { id: thread.projectId }, { enabled: offered }).data;
  const accounts = accountsToContinueWith(thread, list?.accounts ?? [], project);
  const atLimit = thread.session.recovery?.kind === "usage";
  return { accounts, exhausted: Boolean(offered && atLimit && list && project && projectAccountChoice(project, list).restricted && !accounts.length) };
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
