import type { ReactNode } from "react";
import type { AccountsProject } from "@openorc/client";
import { TaskPriority, TaskStatus } from "@openorc/protocol";
import type { useTaskDocumentDraft } from "../../lib/task-document-draft";
import { DocumentEditor } from "../DocumentEditor";
import { useTaskRefine } from "../task-refine/TaskRefine";
import { PriorityIcon, StatusIcon, priorityLabel, priorityOrder, statusLabel, statusOrder } from "../status";
import { Select } from "../ui";
import { TaskLabelsField, TaskTitleField } from "./TaskTextFields";

type Document = ReturnType<typeof useTaskDocumentDraft>;
export function TaskDocumentFields({
  document,
  status,
  priority,
  projectName,
  assignee,
  pending,
  disabled,
  error,
  basePath,
  imageUnavailableReason,
  refine: refinable,
  onStatus,
  onPriority,
}: {
  document: Document;
  status: TaskStatus;
  priority: TaskPriority;
  projectName: string;
  assignee?: ReactNode;
  pending: boolean;
  disabled?: boolean;
  error: string | null;
  basePath?: string;
  imageUnavailableReason?: string;
  /** Tasks on this Mac can be refined by an agent, on the Claude accounts their project uses. */
  refine?: { taskId: string; project: AccountsProject };
  onStatus(value: TaskStatus): void;
  onPriority(value: TaskPriority): void;
}) {
  const { draft, patch, flush } = document;
  const refine = useTaskRefine(refinable?.taskId ?? null, document, basePath, refinable?.project);
  return (
    <>
      {refine.title ?? <TaskTitleField label="Task title" value={draft.title} readOnly={disabled} onChange={(title) => patch({ title })} onBlur={() => void flush()} />}
      <div className="task-properties" aria-label="Task properties">
        {assignee}
        <label className="property-chip">
          <StatusIcon status={status} />
          <Select aria-label="Status" className="property-select" value={status} disabled={pending || disabled} onChange={(event) => onStatus(TaskStatus.parse(event.target.value))}>
            {statusOrder.map((value) => (
              <option key={value} value={value}>
                {statusLabel[value]}
              </option>
            ))}
          </Select>
        </label>
        <label className="property-chip">
          <PriorityIcon priority={priority} />
          <Select aria-label="Priority" className="property-select" value={priority} disabled={pending || disabled} onChange={(event) => onPriority(TaskPriority.parse(event.target.value))}>
            {priorityOrder.map((value) => (
              <option key={value} value={value}>
                {priorityLabel[value]}
              </option>
            ))}
          </Select>
        </label>
        <span className="property-chip truncate" data-tip={projectName}>
          {projectName}
        </span>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-bad mb-3">
          {error}
        </p>
      ) : null}
      <DocumentEditor
        ref={document.body}
        value={draft.spec}
        onChange={(spec) => patch({ spec })}
        onReadyChange={document.reportImagesReady}
        basePath={basePath}
        disabled={disabled}
        imageUnavailableReason={imageUnavailableReason}
        controls={refine.button}
        bar={refine.bar}
        replacement={refine.suggestion}
      />
      {refine.labels ?? <TaskLabelsField label="Labels" value={draft.labels} readOnly={disabled} onChange={(labels) => patch({ labels })} onBlur={() => void flush()} />}
    </>
  );
}
