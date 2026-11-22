import type { AccountsProject } from "@openorc/client";
import type { ClaudeAccount, ThreadChoice } from "@openorc/protocol";
import { modelEffortLabel } from "../../lib/model-effort-label";
import { threadModelKey, useProjectClaudeAccounts, useThreadModels } from "../../lib/thread-choice";
import { ClaudeAccountOptions } from "../ClaudeAccountPicker";
import { Field, Select } from "../ui";

type Variant = "inline" | "sheet";

/** "Default", which leaves the account to the one the thread would inherit, then each account by name. */
export function AccountSelect({
  accounts,
  value,
  onChange,
  variant,
  label,
  disabled,
}: {
  accounts: readonly ClaudeAccount[];
  value: string | undefined;
  onChange: (id: string | undefined) => void;
  variant: Variant;
  /** The select's name where no visible label gives it one. */
  label?: string;
  disabled?: boolean;
}) {
  return (
    <Select variant={variant} aria-label={label} value={value ?? ""} disabled={disabled} onChange={(event) => onChange(event.target.value || undefined)}>
      <option value="">Default</option>
      <ClaudeAccountOptions accounts={accounts} value={value} />
    </Select>
  );
}

/** The Account field where no account can be chosen: disabled, showing whose account the run uses instead. */
export function NoAccount({ reason, variant, label }: { reason: string; variant: Variant; label?: string }) {
  return (
    <Select variant={variant} aria-label={label} value="" disabled>
      <option value="">{reason}</option>
    </Select>
  );
}

export function keptAccountName(accounts: readonly ClaudeAccount[] | undefined, kept: string): string {
  return `${accounts?.find((account) => account.id === kept)?.name ?? "The task's account"} (kept separate)`;
}

type FieldsProps = {
  value: ThreadChoice | undefined;
  onChange: (choice: ThreadChoice | undefined) => void;
  project: AccountsProject | null | undefined;
  /** A Plan run lists only the models that can plan. */
  plan?: boolean;
  /** The first model, which leaves the choice to the task's thread. Without it a model is always chosen. */
  sameLabel?: string;
  /** "card" labels each field above it, as a dialog does; "sheet" names them for screen readers only. */
  layout: "card" | "sheet";
  disabled?: boolean;
  /** The account a Claude choice stays on, shown but not offered, while accounts are kept separate. */
  keptAccount?: string | undefined;
};

export function ThreadChoiceFields({ value, onChange, project, plan = false, sameLabel, layout, disabled, keptAccount }: FieldsProps) {
  const { models, options } = useThreadModels(plan);
  const accounts = useProjectClaudeAccounts(project, keptAccount ?? value?.claudeAccountId, value?.agent === "claude");
  const variant: Variant = layout === "sheet" ? "sheet" : "inline";
  const chooseModel = (key: string) => {
    const option = options.find((candidate) => threadModelKey(candidate.recipient) === key);
    if (!option) return onChange(undefined);
    const { agent, model, effort } = option.recipient;
    onChange({ agent, model, effort, ...(agent === "claude" && value?.claudeAccountId ? { claudeAccountId: value.claudeAccountId } : {}) });
  };
  const chooseAccount = (id: string | undefined) => value && onChange({ agent: value.agent, model: value.model, effort: value.effort, ...(id ? { claudeAccountId: id } : {}) });
  const listed = value && !options.some((option) => threadModelKey(option.recipient) === threadModelKey(value));
  const model = (
    <Select
      variant={variant}
      aria-label={layout === "sheet" ? "Model" : undefined}
      value={value ? threadModelKey(value) : ""}
      disabled={disabled}
      onChange={(event) => chooseModel(event.target.value)}
    >
      {sameLabel ? <option value="">{sameLabel}</option> : null}
      {/* A model saved earlier that the agents no longer offer stays chosen until another is. */}
      {listed ? <option value={threadModelKey(value)}>{modelEffortLabel(value, models)}</option> : null}
      {options.map((option) => (
        <option key={threadModelKey(option.recipient)} value={threadModelKey(option.recipient)}>
          {option.name}
        </option>
      ))}
    </Select>
  );
  const accountLabel = layout === "sheet" ? "Account" : undefined;
  let account = <NoAccount reason="Default" variant={variant} label={accountLabel} />;
  if (value?.agent === "claude" && keptAccount) account = <NoAccount reason={keptAccountName(accounts, keptAccount)} variant={variant} label={accountLabel} />;
  else if (value?.agent === "claude" && accounts)
    account = <AccountSelect accounts={accounts} value={value.claudeAccountId} onChange={chooseAccount} variant={variant} label={accountLabel} disabled={disabled} />;
  if (layout === "sheet")
    return (
      <>
        {model}
        {account}
      </>
    );
  return (
    <div className="grid grid-cols-2 items-start gap-3">
      <Field label="Model">{model}</Field>
      <Field label="Account">{account}</Field>
    </div>
  );
}
