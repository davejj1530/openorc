import { projectAccountChoice, type AccountsProject } from "@openorc/client";
import { HarnessId, isHarnessId, type ThreadChoice } from "@openorc/protocol";
import type { ReactNode } from "react";
import { useRpc } from "../lib/client";
import { Automation } from "./icons";
import { ModelPicker, type ModelChoice } from "./ModelPicker";
import type { PickerAccounts } from "./ModelPickerAccounts";
import "./agent-brief.css";

/** Every agent the person has switched on, without Fast mode, which a saved choice does not keep. */
const LIMITS = { harnesses: HarnessId.options, fast: false };

/** A model chosen in the picker as a saved choice: the account stays while the model is still Claude's. */
function threadChoice(next: ModelChoice, last: ThreadChoice | null): ThreadChoice | null {
  if (!isHarnessId(next.agent)) return null;
  const account = next.agent === "claude" && last?.claudeAccountId ? { claudeAccountId: last.claudeAccountId } : {};
  return { agent: next.agent, model: next.model, effort: next.effort, ...account };
}

/** The Claude accounts a Claude model can run on in the project, when it uses more than one: the one chosen, else the project's default. */
function useChoiceAccounts(project: AccountsProject | undefined, choice: ThreadChoice | null, onChoice: (choice: ThreadChoice) => void): PickerAccounts | undefined {
  const claude = choice?.agent === "claude" ? choice : null;
  const list = useRpc("claude.accounts.list", {}, { enabled: Boolean(claude) }).data;
  if (!claude || !list) return undefined;
  const { accounts, defaultId } = projectAccountChoice(project, list);
  if (accounts.filter((account) => account.enabled).length < 2) return undefined;
  return { accounts, current: claude.claudeAccountId ?? defaultId, choose: (id) => onChoice({ ...claude, claudeAccountId: id }) };
}

/**
 * What an agent is told and the model that reads it, as one field: the words written as a message would be, and the
 * model at the box's foot in the app's model picker, with `action` at the foot's end. `sameLabel`, when given, names the
 * choice that leaves the model to wherever the agent runs, the picker's first.
 */
export function AgentBrief({
  words,
  onWords,
  onLeave,
  choice,
  onChoice,
  project,
  sameLabel,
  placeholder,
  label = "What the agent is told",
  maxLength = 8000,
  rows = 5,
  disabled,
  action,
  showEffort = true,
}: {
  words: string;
  onWords: (words: string) => void;
  /** The words were left, for a box that saves by itself. */
  onLeave?: () => void;
  choice: ThreadChoice | null;
  onChoice: (choice: ThreadChoice | null) => void;
  project: AccountsProject | undefined;
  sameLabel?: string | undefined;
  placeholder: string;
  label?: string;
  maxLength?: number;
  rows?: number;
  disabled?: boolean;
  action?: ReactNode;
  /** Whether the picker offers the model's effort, which a one-shot answer does not use. */
  showEffort?: boolean;
}) {
  const accounts = useChoiceAccounts(project, choice, onChoice);
  const value = choice ? { agent: choice.agent, model: choice.model, effort: choice.effort } : null;
  return (
    <div className="agent-brief">
      <textarea
        className="agent-brief-words"
        aria-label={label}
        rows={rows}
        maxLength={maxLength}
        value={words}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onWords(event.target.value)}
        onBlur={onLeave}
      />
      <div className="agent-brief-foot">
        <ModelPicker
          value={value}
          onChange={(next) => onChoice(threadChoice(next, choice))}
          accounts={accounts}
          limits={LIMITS}
          ariaLabel="Model"
          showEffort={showEffort}
          unset={sameLabel ? { label: sameLabel, icon: <Automation size={14} />, choose: () => onChoice(null) } : undefined}
          {...(disabled ? { disabled } : {})}
        />
        {action}
      </div>
    </div>
  );
}
