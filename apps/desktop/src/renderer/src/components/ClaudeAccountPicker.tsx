import type { ClaudeAccounts } from "@openorc/protocol";
import { Select, TextButton } from "./ui";
import { useRouter } from "../lib/router";

/**
 * The Claude account a run uses, from the accounts it is given: the app's, or the ones a project uses, already narrowed
 * by the caller. The compact chip drops the visible label; its select keeps the name.
 */
export function ClaudeAccountPicker({
  accounts,
  value,
  onChange,
  disabled,
  compact = false,
}: {
  accounts: ClaudeAccounts | undefined;
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <div className="flex items-center gap-1 min-w-0">
      {compact ? null : <span className="text-sm text-ink-2 shrink-0">Claude account</span>}
      <Select aria-label="Claude account" value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled || !accounts} className="h-7 max-w-48 rounded-full text-sm">
        {!accounts ? <option value={value}>Loading accounts…</option> : null}
        <ClaudeAccountOptions accounts={accounts} value={value} />
      </Select>
      <TextButton className="text-sm shrink-0 px-2" onClick={() => useRouter.getState().navigate({ view: "settings", section: "connections" })}>
        Manage
      </TextButton>
    </div>
  );
}

/** Each account as a choice. A disabled one stays listed, and only the choice already made can keep it. */
export function ClaudeAccountOptions({ accounts, value }: { accounts: ClaudeAccounts | undefined; value: string | null | undefined }) {
  return (
    <>
      {accounts?.accounts.map((account) => (
        <option key={account.id} value={account.id} disabled={!account.enabled && account.id !== value}>
          {account.name}
          {account.enabled ? "" : " · disabled"}
        </option>
      ))}
    </>
  );
}
