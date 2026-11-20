import { useState } from "react";
import { executionModePresentation, MAX_TASK_BUTTONS, type Project, type TaskButton } from "@openorc/protocol";
import { queryClient, useRpc, useRpcMutation } from "../../lib/client";
import { modelEffortLabel } from "../../lib/model-effort-label";
import { Plus, Trash2 } from "../icons";
import { Button, IconButton, Tooltip } from "../ui";
import { statusLabel } from "../status";
import { shownOn, TaskButtonDialog } from "./TaskButtonDialog";
import { useProjectClaudeAccounts } from "../task-threads/ThreadChoiceFields";
import "./task-buttons.css";

/** Laid out as Schedules lists schedules. Saving the dialog or removing a row saves the whole list. */
export function TaskButtonsSection({ project }: { project: Project }) {
  const update = useRpcMutation("projects.updateSettings");
  const [editing, setEditing] = useState<TaskButton | "new" | null>(null);
  const buttons = project.settings.taskButtons ?? [];
  const save = (next: TaskButton[], onSaved?: () => void) =>
    update.mutate(
      { id: project.id, settings: { taskButtons: next } },
      {
        onSuccess: (saved) => {
          queryClient.setQueryData(["projects.get", { id: project.id }], saved);
          onSaved?.();
        },
      },
    );
  const put = (button: TaskButton) =>
    save(buttons.some((each) => each.id === button.id) ? buttons.map((each) => (each.id === button.id ? button : each)) : [...buttons, button], () => setEditing(null));
  const close = () => {
    update.reset();
    setEditing(null);
  };
  return (
    <section className="settings-section project-task-buttons" aria-labelledby="project-task-buttons-title">
      <header className="settings-section-intro">
        <div className="settings-section-heading">
          <h2 id="project-task-buttons-title">Task buttons</h2>
          <div className="settings-section-actions">
            <Button size="sm" disabled={buttons.length >= MAX_TASK_BUTTONS || update.isPending} onClick={() => setEditing("new")}>
              <Plus size={13} /> Add button
            </Button>
          </div>
        </div>
        <p>Shown beside Open thread on this project&apos;s tasks.</p>
      </header>
      <div className="settings-section-body settings-group">
        {buttons.length ? (
          <ol className="task-button-list" aria-label="Task buttons">
            {buttons.map((button) => (
              <TaskButtonRow
                key={button.id}
                button={button}
                project={project}
                busy={update.isPending}
                onEdit={() => setEditing(button)}
                onRemove={() => save(buttons.filter((each) => each.id !== button.id))}
              />
            ))}
          </ol>
        ) : (
          <p className="task-button-empty">No buttons yet. A Review button could start a new thread that reviews the task&apos;s changes, for example.</p>
        )}
        {update.error && !editing ? (
          <p role="alert" className="task-button-error">
            {update.error.message}
          </p>
        ) : null}
      </div>
      {editing ? (
        <TaskButtonDialog initial={editing === "new" ? null : editing} project={project} pending={update.isPending} error={update.error?.message ?? null} onSave={put} onClose={close} />
      ) : null}
    </section>
  );
}

function useButtonSummary(button: TaskButton, project: Project): string {
  const models = useRpc("agents.models", {}, { staleTime: 300000 }).data;
  const accountId = button.choice?.claudeAccountId;
  const accounts = useProjectClaudeAccounts(project, accountId, Boolean(accountId));
  const where = button.runsIn === "task" ? "Current thread" : "New thread";
  const mode = button.mode === "thread" ? null : executionModePresentation(button.choice?.agent, button.mode).label;
  const model = button.choice ? modelEffortLabel(button.choice, models) : null;
  const account = accountId ? (accounts?.find((each) => each.id === accountId)?.name ?? null) : null;
  const sends = button.autoSend === false ? "Opens as a draft" : null;
  return [where, mode, model, account, button.includeTask === false ? "Prompt only" : null, sends, shownSummary(button.statuses)].filter(Boolean).join(" · ");
}

/** Where a button shows, unless that is every status a button can show on. */
function shownSummary(statuses: TaskButton["statuses"]): string | null {
  const shown = shownOn(statuses);
  if (!shown) return null;
  return shown.length ? `Shown on ${shown.map((status) => statusLabel[status]).join(", ")}` : "Shown nowhere";
}

function TaskButtonRow({ button, project, busy, onEdit, onRemove }: { button: TaskButton; project: Project; busy: boolean; onEdit: () => void; onRemove: () => void }) {
  const summary = useButtonSummary(button, project);
  return (
    <li className="task-button-row">
      <button type="button" className="task-button-open" aria-label={`Edit ${button.label} button`} onClick={onEdit}>
        <span className="task-button-preview">{button.label}</span>
        <span className="task-button-text">
          <span className="task-button-prompt">{button.prompt}</span>
          <span className="task-button-meta">{summary}</span>
        </span>
      </button>
      <Tooltip label="Remove">
        <IconButton aria-label={`Remove ${button.label} button`} disabled={busy} onClick={onRemove}>
          <Trash2 size={15} />
        </IconButton>
      </Tooltip>
    </li>
  );
}
