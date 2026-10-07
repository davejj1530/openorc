import type { ClaudeAccounts } from "@openorc/protocol";
import { Select, TextButton } from "./ui";
import { useRouter } from "../lib/router";
import { useRpc } from "../lib/query";
import { useClaudeAccountId } from "../lib/claude-account";

export function ClaudeAccountPicker({ accounts, value, onChange, disabled }: { accounts: ClaudeAccounts | undefined; value: string; onChange: (id: string) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center gap-2 min-w-0 py-2">
      <label className="text-sm text-ink-2 flex items-center gap-2 min-w-0">
        Claude account
        <Select aria-label="Claude account" value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled || !accounts} className="max-w-56">
          {!accounts ? <option value={value}>Loading accounts…</option> : null}
          {accounts?.accounts.map((account) => (
            <option key={account.id} value={account.id} disabled={!account.enabled}>
              {account.name}
              {account.enabled ? "" : " · disabled"}
            </option>
          ))}
        </Select>
      </label>
      <TextButton className="text-sm shrink-0" onClick={() => useRouter.getState().navigate({ view: "settings", section: "connections" })}>
        Manage
      </TextButton>
    </div>
  );
}

export function ThreadClaudeAccount() {
  const id = useClaudeAccountId();
  const { data } = useRpc("claude.accounts.list", {});
  const account = data?.accounts.find((entry) => entry.id === id);
  return (
    <span className="text-xs text-ink-2 truncate max-w-40" title={`Claude account: ${account?.name ?? "Existing CLI login"}`}>
      {account?.name ?? "Existing CLI login"}
    </span>
  );
}
