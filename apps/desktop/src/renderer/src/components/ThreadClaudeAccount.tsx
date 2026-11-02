import { Menu } from "@base-ui/react/menu";
import { useState } from "react";
import type { ClaudeAccountConnection, ThreadSummary } from "@openorc/protocol";
import { CoversPreview } from "../lib/browser-preview";
import { useClaudeAccountId } from "../lib/claude-account";
import { useRpc, useRpcMutation } from "../lib/client";
import { useRouter } from "../lib/router";
import { floatingGround } from "../lib/use-anchor-ground";
import { Check, ChevronDown } from "./icons";
import { menuItem, menuPopup, menuSeparator } from "./menu";

const unavailable: Record<ClaudeAccountConnection["status"], string | null> = {
  ready: null,
  signing_in: "signing in",
  signed_out: "signed out",
  disabled: "disabled",
  unavailable: "unavailable",
};

/**
 * The thread's Claude account, a faint fact in its header. With more than one account it is a menu that moves the
 * conversation to another between turns; the next message resumes its session there. An Orcling keeps its own.
 */
export function ThreadClaudeAccount({ thread }: { thread: ThreadSummary }) {
  const id = useClaudeAccountId();
  const { data } = useRpc("claude.accounts.list", {});
  const name = data?.accounts.find((entry) => entry.id === id)?.name ?? "Existing CLI login";
  if (!id || !data || data.accounts.length < 2 || thread.orclingId || thread.teamInstanceId)
    return (
      <span className="text-sm text-ink-4 truncate max-w-40" title={`Claude account: ${name}`}>
        {name}
      </span>
    );
  return <AccountSwitch thread={thread} accounts={data.accounts} current={id} name={name} />;
}

function AccountSwitch({ thread, accounts, current, name }: { thread: ThreadSummary; accounts: ClaudeAccountConnection[]; current: string; name: string }) {
  const [open, setOpen] = useState(false);
  const switching = useRpcMutation("threads.switchClaudeAccount");
  const working = thread.activity !== "idle";
  const choose = (claudeAccountId: string) => {
    if (claudeAccountId === current) setOpen(false);
    else switching.mutate({ id: thread.id, claudeAccountId }, { onSuccess: () => setOpen(false) });
  };
  return (
    <Menu.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) switching.reset();
      }}
    >
      <Menu.Trigger className="thread-header-fact thread-header-fact-link" aria-label={`Claude account: ${name}`}>
        <span className="truncate max-w-40">{name}</span>
        <ChevronDown size={12} />
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner sideOffset={6} align="start" className="z-40" collisionPadding={8}>
          <Menu.Popup ref={floatingGround} className={menuPopup}>
            {working ? (
              <div className="max-w-64 px-2 py-1 text-xs text-ink-3" role="status">
                Switch accounts when this turn ends.
              </div>
            ) : null}
            {switching.error ? (
              <div className="max-w-64 px-2 py-1 text-xs text-bad break-words" role="alert">
                {switching.error.message}
              </div>
            ) : null}
            {accounts.map((account) => {
              const reason = account.id === current ? null : unavailable[account.status];
              return (
                <Menu.Item key={account.id} className={menuItem} closeOnClick={false} disabled={working || switching.isPending || Boolean(reason)} onClick={() => choose(account.id)}>
                  <span className="flex-1 min-w-0 truncate">{account.name}</span>
                  {account.id === current ? <Check size={13} /> : null}
                  {reason ? <span className="text-xs text-ink-4">{reason}</span> : null}
                </Menu.Item>
              );
            })}
            <Menu.Separator className={menuSeparator} />
            <Menu.Item className={menuItem} onClick={() => useRouter.getState().navigate({ view: "settings", section: "connections" })}>
              Manage accounts
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
