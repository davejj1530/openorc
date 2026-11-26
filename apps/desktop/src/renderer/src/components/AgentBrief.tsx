import type { AccountsProject } from "@openorc/client";
import type { ThreadChoice } from "@openorc/protocol";
import { HarnessLogo } from "./HarnessLogo";
import { Automation } from "./icons";
import { ThreadChoiceFields } from "./task-threads/ThreadChoiceFields";
import "./agent-brief.css";

/**
 * What an agent is told and the model that reads it, as one field: the words written as a message would be, and the
 * model at the box's foot. `sameLabel` names the choice that leaves the model to wherever the agent runs.
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
  rows = 5,
  disabled,
}: {
  words: string;
  onWords: (words: string) => void;
  /** The words were left, for a box that saves by itself. */
  onLeave?: () => void;
  choice: ThreadChoice | null;
  onChoice: (choice: ThreadChoice | null) => void;
  project: AccountsProject | undefined;
  sameLabel: string;
  placeholder: string;
  rows?: number;
  disabled?: boolean;
}) {
  return (
    <div className="agent-brief">
      <textarea
        className="agent-brief-words"
        aria-label="What the agent is told"
        rows={rows}
        maxLength={8000}
        value={words}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onWords(event.target.value)}
        onBlur={onLeave}
      />
      <div className="agent-brief-foot">
        <span className="agent-brief-mark" aria-hidden="true">
          {choice ? <HarnessLogo id={choice.agent} size={16} /> : <Automation size={16} />}
        </span>
        <ThreadChoiceFields value={choice ?? undefined} onChange={(next) => onChoice(next ?? null)} project={project} sameLabel={sameLabel} layout="bar" {...(disabled ? { disabled } : {})} />
      </div>
    </div>
  );
}
