import { useState, type ReactElement } from "react";
import type { AccountsProject } from "@openorc/client";
import type { ClaudeAccount, CommentMentionOption, ModelOption, Thread, ThreadChoice } from "@openorc/protocol";
import { threadModelKey, useProjectClaudeAccounts, useThreadModels } from "../../lib/thread-choice";
import { ThreadChoiceFields } from "./ThreadChoiceFields";
import { TaskSheet, useTaskSheet } from "./TaskSheet";

/** The model and account a thread would get without a choice; a null model or effort is the agent's default. */
export type InheritedSettings = Pick<Thread, "agent" | "model" | "effort" | "claudeAccountId">;

/** The choice the sheet starts on, and whether it is the inherited model itself rather than the nearest one offered. */
type Prefill = { choice: ThreadChoice; inherited: boolean };

/**
 * The inherited settings as a choice the fields offer: the model, or the agent's default, at its effort or the model's
 * default, else the nearest one listed. The account stays while the project uses it; otherwise the project's default.
 */
function prefill(inherited: InheritedSettings, options: readonly CommentMentionOption[], models: readonly ModelOption[] | undefined, accounts: readonly ClaudeAccount[]): Prefill | undefined {
  const model = inherited.model ?? models?.find((candidate) => candidate.agent === inherited.agent && candidate.isDefault)?.id;
  const effort = inherited.effort ?? models?.find((candidate) => candidate.agent === inherited.agent && candidate.id === model)?.defaultEffort ?? null;
  const key = model ? threadModelKey({ agent: inherited.agent as ThreadChoice["agent"], model, effort }) : null;
  const exact = options.find((candidate) => threadModelKey(candidate.recipient) === key);
  const option =
    exact ??
    options.find((candidate) => candidate.recipient.agent === inherited.agent && candidate.recipient.model === model) ??
    options.find((candidate) => candidate.recipient.agent === inherited.agent) ??
    options[0];
  if (!option) return undefined;
  const { agent, model: chosen, effort: chosenEffort } = option.recipient;
  const account = agent === "claude" ? accounts.find((candidate) => candidate.id === inherited.claudeAccountId)?.id : undefined;
  return { choice: { agent, model: chosen, effort: chosenEffort, ...(account ? { claudeAccountId: account } : {}) }, inherited: option === exact };
}

const sameChoice = (a: ThreadChoice, b: ThreadChoice) => threadModelKey(a) === threadModelKey(b) && a.claudeAccountId === b.claudeAccountId;

/** Nothing while the sheet shows the inherited model and account unchanged, else the choice shown, which may stand in for a model not offered here. */
const asked = (choice: ThreadChoice, prefilled: Prefill): ThreadChoice | undefined => (prefilled.inherited && sameChoice(choice, prefilled.choice) ? undefined : choice);

type SheetProps = {
  title: string;
  confirm: string;
  /** Undefined until it is known, which keeps the sheet from confirming. */
  inherited: InheritedSettings | undefined;
  project: AccountsProject | null | undefined;
  trigger: ReactElement;
  side: "top" | "bottom";
  align: "start" | "end";
  /** Called with the choice, or with none when the person kept what the thread would inherit. Throws to say why it failed. */
  onConfirm: (choice: ThreadChoice | undefined) => Promise<void>;
  /** The account a Claude choice stays on, while accounts are kept separate. */
  keptAccount?: string | undefined;
};

const onAccount = (choice: ThreadChoice, kept: string | undefined): ThreadChoice => (kept && choice.agent === "claude" ? { ...choice, claudeAccountId: kept } : choice);

/**
 * A sheet that starts a task's thread on the model and account chosen, prefilled with the ones it would inherit. Keeping
 * those asks for nothing, so the thread starts exactly as it would without the sheet; a stand-in for them is asked for.
 */
export function ThreadChoiceSheet({ title, confirm, inherited, project, trigger, side, align, onConfirm, keptAccount }: SheetProps) {
  const [edited, setEdited] = useState<ThreadChoice | undefined>();
  const sheet = useTaskSheet(() => setEdited(undefined));
  const { models, options } = useThreadModels(false);
  const accounts = useProjectClaudeAccounts(project, undefined, sheet.open);
  // Until the accounts arrive, the choice keeps no account, so confirming leaves the account to the one the thread would inherit.
  const filled = inherited && prefill(inherited, options, models, accounts ?? []);
  const prefilled = filled && { ...filled, choice: onAccount(filled.choice, keptAccount) };
  const choice = edited ? onAccount(edited, keptAccount) : prefilled?.choice;
  return (
    <TaskSheet
      sheet={sheet}
      title={title}
      trigger={trigger}
      side={side}
      align={align}
      confirm={confirm}
      pendingLabel="Opening…"
      ready={Boolean(choice && prefilled)}
      onConfirm={() => onConfirm(choice && prefilled ? asked(choice, prefilled) : undefined)}
    >
      <ThreadChoiceFields value={choice} onChange={setEdited} project={project} layout="sheet" disabled={sheet.pending || !choice} keptAccount={keptAccount} />
    </TaskSheet>
  );
}
