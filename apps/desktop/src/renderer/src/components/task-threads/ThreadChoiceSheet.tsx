import { useState, type ReactElement } from "react";
import type { AccountsProject } from "@openorc/client";
import type { ClaudeAccount, CommentMentionOption, ModelOption, Thread, ThreadChoice } from "@openorc/protocol";
import { threadModelKey, ThreadChoiceFields, useProjectClaudeAccounts, useThreadModels } from "./ThreadChoiceFields";
import { TaskSheet, useTaskSheet } from "./TaskSheet";

/** The model and account a thread would get without a choice; a null model or effort is the agent's default. */
export type InheritedSettings = Pick<Thread, "agent" | "model" | "effort" | "claudeAccountId">;

/**
 * The inherited settings as a choice the fields offer: the model, or the agent's default, at its effort or the model's
 * default, else the nearest one listed. The account stays while the project uses it; otherwise the project's default.
 */
function inheritedChoice(
  inherited: InheritedSettings,
  options: readonly CommentMentionOption[],
  models: readonly ModelOption[] | undefined,
  accounts: readonly ClaudeAccount[],
): ThreadChoice | undefined {
  const model = inherited.model ?? models?.find((candidate) => candidate.agent === inherited.agent && candidate.isDefault)?.id;
  const effort = inherited.effort ?? models?.find((candidate) => candidate.agent === inherited.agent && candidate.id === model)?.defaultEffort ?? null;
  const key = model ? threadModelKey({ agent: inherited.agent as ThreadChoice["agent"], model, effort }) : null;
  const option =
    options.find((candidate) => threadModelKey(candidate.recipient) === key) ??
    options.find((candidate) => candidate.recipient.agent === inherited.agent && candidate.recipient.model === model) ??
    options.find((candidate) => candidate.recipient.agent === inherited.agent) ??
    options[0];
  if (!option) return undefined;
  const { agent, model: chosen, effort: chosenEffort } = option.recipient;
  const account = agent === "claude" ? accounts.find((candidate) => candidate.id === inherited.claudeAccountId)?.id : undefined;
  return { agent, model: chosen, effort: chosenEffort, ...(account ? { claudeAccountId: account } : {}) };
}

const sameChoice = (a: ThreadChoice, b: ThreadChoice) => threadModelKey(a) === threadModelKey(b) && a.claudeAccountId === b.claudeAccountId;

type SheetProps = {
  title: string;
  confirm: string;
  inherited: InheritedSettings;
  project: AccountsProject | null | undefined;
  trigger: ReactElement;
  side: "top" | "bottom";
  align: "start" | "end";
  /** Called with the choice, or with none when the person kept what the thread would inherit. Throws to say why it failed. */
  onConfirm: (choice: ThreadChoice | undefined) => Promise<void>;
};

/**
 * A sheet that starts a task's thread on the model and account chosen, prefilled with the ones it would inherit. Keeping
 * those asks for nothing, so the thread starts exactly as it would without the sheet.
 */
export function ThreadChoiceSheet({ title, confirm, inherited, project, trigger, side, align, onConfirm }: SheetProps) {
  const [edited, setEdited] = useState<ThreadChoice | undefined>();
  const sheet = useTaskSheet(() => setEdited(undefined));
  const { models, options } = useThreadModels(false);
  const accounts = useProjectClaudeAccounts(project, undefined, sheet.open);
  // Until the accounts arrive, the choice keeps no account: confirming then asks for nothing, as Open thread does.
  const prefilled = inheritedChoice(inherited, options, models, accounts ?? []);
  const choice = edited ?? prefilled;
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
      onConfirm={() => onConfirm(choice && prefilled && !sameChoice(choice, prefilled) ? choice : undefined)}
    >
      <ThreadChoiceFields value={choice} onChange={setEdited} project={project} layout="sheet" disabled={sheet.pending || !choice} />
    </TaskSheet>
  );
}
