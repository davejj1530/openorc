import { useMemo } from "react";
import { projectAccountChoice, type AccountsProject } from "@openorc/client";
import {
  commentMentionOptions,
  commentRecipientKey,
  executionModeAvailable,
  harnessLoggedIn,
  type ClaudeAccount,
  type CommentMentionOption,
  type ModelOption,
  type ThreadChoice,
} from "@openorc/protocol";
import { useRpc } from "../../lib/client";
import { modelEffortLabel } from "../../lib/model-effort-label";
import { ClaudeAccountOptions } from "../ClaudeAccountPicker";
import { Field, Select } from "../ui";

type Variant = "inline" | "sheet";
type ThreadModel = Pick<ThreadChoice, "agent" | "model" | "effort">;

export const threadModelKey = (choice: ThreadModel): string => commentRecipientKey({ agent: choice.agent, model: choice.model, effort: choice.effort });

/** The agents signed in on this machine. Undefined until the check answers, so nothing is hidden before it does. */
export function useSignedInAgents(): ReadonlySet<string> | undefined {
  const rows = useRpc("agents.availability", {}, { staleTime: 60000 }).data;
  return useMemo(() => (rows ? new Set(rows.filter(harnessLoggedIn).map((row) => row.id)) : undefined), [rows]);
}

const NO_OPTIONS: readonly CommentMentionOption[] = [];

/**
 * Every model and effort a task's thread can start with, from the agents signed in here, named as comments name them,
 * after any of `first`, such as Orclings, whose agent can run here too. A Plan run needs Plan.
 */
export function useThreadModels(plan: boolean, first = NO_OPTIONS): { models: ModelOption[] | undefined; options: CommentMentionOption[] } {
  const models = useRpc("agents.models", {}, { staleTime: 300000 }).data;
  const signedIn = useSignedInAgents();
  const options = useMemo(
    () =>
      [...first, ...commentMentionOptions((models ?? []).filter((model) => !model.unavailable))].filter(
        ({ recipient }) => (!signedIn || signedIn.has(recipient.agent)) && (!plan || executionModeAvailable(recipient.agent, "plan")),
      ),
    [first, models, plan, signedIn],
  );
  return { models, options };
}

/**
 * The Claude accounts a thread in the project can start on: the project's own while it keeps them, else the app's
 * enabled ones. One chosen before the project stopped using it stays listed, so the choice shows by name.
 */
export function useProjectClaudeAccounts(project: AccountsProject | null | undefined, chosen?: string, enabled = true): ClaudeAccount[] | undefined {
  const list = useRpc("claude.accounts.list", {}, { enabled }).data;
  if (!list) return undefined;
  const allowed = projectAccountChoice(project, list).accounts.filter((account) => account.enabled);
  return chosen && !allowed.some((account) => account.id === chosen) ? [...allowed, ...list.accounts.filter((account) => account.id === chosen)] : allowed;
}

/** "Default", which leaves the account to the project, then each account by name. */
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
      <ClaudeAccountOptions accounts={{ accounts }} value={value} />
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
};

export function ThreadChoiceFields({ value, onChange, project, plan = false, sameLabel, layout, disabled }: FieldsProps) {
  const { models, options } = useThreadModels(plan);
  const accounts = useProjectClaudeAccounts(project, value?.claudeAccountId, value?.agent === "claude");
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
  if (value?.agent === "claude" && accounts)
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
