import { useId, useState } from "react";
import {
  buttonExecutionMode,
  ExecutionMode,
  executionModeAvailable,
  executionModePresentation,
  savedSkillPrompt,
  type Project,
  type TaskButton,
  type TaskStatus,
  type ThreadChoice,
} from "@openorc/protocol";
import { statusLabel } from "../status";
import { Button, Checkbox, Chip, Dialog, Field, Input, Select } from "../ui";
import { PromptField, usePromptSkills, type PromptSkill } from "./TaskButtonPrompt";
import { showable, shownOn } from "./task-button-rules";
import { ThreadChoiceFields } from "../task-threads/ThreadChoiceFields";

const modes = ["thread", ...ExecutionMode.options] as const;
const buttonMode = (value: string): TaskButton["mode"] => modes.find((mode) => mode === value) ?? "thread";

/**
 * The button as it is saved, trimmed, with its calls of skills written `/name` and the skills it calls, when it calls
 * any. A skill saved before still counts while the prompt calls it, though the agent no longer lists it.
 */
function savedButton({ skills: saved, statuses, ...button }: TaskButton, offered: readonly PromptSkill[]): TaskButton {
  const { prompt, skills } = savedSkillPrompt(button.prompt.trim(), [...offered.map((skill) => skill.name), ...(saved ?? [])]);
  const shown = shownOn(statuses);
  return { ...button, label: button.label.trim(), prompt, ...(shown ? { statuses: shown } : {}), ...(skills.length ? { skills } : {}) };
}

/** A group, not a Field: a label around the chips would make its title press the first one. */
function ShowOnField({ statuses, disabled, onChange }: { statuses: TaskStatus[] | undefined; disabled: boolean; onChange: (statuses: TaskStatus[] | undefined) => void }) {
  const titleId = useId();
  const shown = shownOn(statuses) ?? showable;
  const toggle = (status: TaskStatus) => onChange(shownOn(showable.filter((each) => (each === status) !== shown.includes(each))));
  return (
    <div className="grid min-w-0 gap-1 mb-3" role="group" aria-labelledby={titleId}>
      <span id={titleId} className="text-sm text-ink-3">
        Show on
      </span>
      <div className="task-button-statuses">
        {showable.map((status) => (
          <Chip key={status} className="h-7 px-2.5 text-sm" pressed={shown.includes(status)} disabled={disabled} onClick={() => toggle(status)}>
            {statusLabel[status]}
          </Chip>
        ))}
      </div>
      {shown.length ? null : <span className="text-xs text-ink-4">Pick at least one status.</span>}
    </div>
  );
}

/** A task button's fields, as the schedule editor lays out a schedule's: what it is, what it says, then how it runs. */
export function TaskButtonDialog({
  initial,
  project,
  pending,
  error,
  onSave,
  onClose,
}: {
  initial: TaskButton | null;
  project: Project;
  pending: boolean;
  error: string | null;
  onSave: (button: TaskButton) => void;
  onClose: () => void;
}) {
  const [button, setButton] = useState<TaskButton>(() =>
    initial ? { ...initial, mode: buttonExecutionMode(initial) ?? "thread" } : { id: crypto.randomUUID(), label: "", prompt: "", runsIn: "new", mode: "plan" },
  );
  const edit = (patch: Partial<TaskButton>) => setButton((current) => ({ ...current, ...patch }));
  const agent = button.choice?.agent;
  // A mode the new model's agent can't run goes back to Default, as the list no longer shows it.
  const chooseModel = (choice: ThreadChoice | undefined) => edit({ choice, ...(button.mode !== "thread" && !executionModeAvailable(choice?.agent, button.mode) ? { mode: "thread" as const } : {}) });
  const { skills, onSkillsWanted } = usePromptSkills(project.id, button.choice);
  const ready = Boolean(button.label.trim() && button.prompt.trim() && shownOn(button.statuses)?.length !== 0);
  const saveLabel = initial ? "Save" : "Add button";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      title={initial ? "Edit button" : "New button"}
      width={560}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) onSave(savedButton(button, skills));
        }}
      >
        <Field label="Label">
          <Input autoFocus maxLength={40} placeholder="Review" value={button.label} disabled={pending} onChange={(event) => edit({ label: event.target.value })} />
        </Field>
        <ShowOnField statuses={button.statuses} disabled={pending} onChange={(statuses) => edit({ statuses })} />
        <PromptField value={button.prompt} onChange={(prompt) => edit({ prompt })} skills={skills} onSkillsWanted={onSkillsWanted} disabled={pending} />
        <div className="task-button-checks">
          <label>
            <Checkbox checked={button.includeTask !== false} disabled={pending} onChange={(event) => edit({ includeTask: event.target.checked ? undefined : false })} />
            Include the task
          </label>
          <label>
            <Checkbox checked={button.autoSend !== false} disabled={pending} onChange={(event) => edit({ autoSend: event.target.checked ? undefined : false })} />
            Send right away
          </label>
        </div>
        <div className="grid grid-cols-2 items-start gap-3">
          <Field label="Runs in">
            <Select value={button.runsIn} disabled={pending} onChange={(event) => edit({ runsIn: event.target.value === "task" ? "task" : "new" })}>
              <option value="task">Current thread</option>
              <option value="new">New thread</option>
            </Select>
          </Field>
          <Field label="Mode">
            <Select value={button.mode} disabled={pending} onChange={(event) => edit({ mode: buttonMode(event.target.value) })}>
              <option value="thread">Default</option>
              {ExecutionMode.options.map((mode) => (
                <option key={mode} value={mode} hidden={!executionModeAvailable(agent, mode)}>
                  {executionModePresentation(agent, mode).label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <ThreadChoiceFields value={button.choice} onChange={chooseModel} project={project} plan={button.mode === "plan"} sameLabel="Default" layout="card" disabled={pending} />
        {error ? (
          <p className="text-sm text-bad mb-3 break-words" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={pending || !ready}>
            {pending ? "Saving…" : saveLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
