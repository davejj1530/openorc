import type { ReactNode } from "react";
import { TaskPriority, TaskStatus } from "@openorc/protocol";
import type { useTaskDocumentDraft } from "../../lib/task-document-draft";
import { DocumentEditor } from "../DocumentEditor";
import { PriorityIcon, StatusIcon, priorityLabel, priorityOrder, statusLabel, statusOrder } from "../status";
import { Select } from "../ui";

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
  onStatus(value: TaskStatus): void;
  onPriority(value: TaskPriority): void;
}) {
  const { draft, patch, flush } = document;
  return (
    <>
      <textarea
        rows={1}
        aria-label="Task title"
        className="document-title native-field"
        value={draft.title}
        readOnly={disabled}
        onChange={(e) => patch({ title: e.target.value.replace(/\n/g, " ") })}
        onBlur={() => void flush()}
      />
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
      />
      <div className="flex flex-wrap items-center gap-3 mt-6 text-sm text-ink-3">
        <label className="flex min-w-0 items-center gap-2">
          <span>Labels</span>
          <input
            aria-label="Labels"
            className="bg-transparent py-1 text-ink-2 placeholder:text-ink-4"
            placeholder="Add labels, comma separated"
            value={draft.labels}
            readOnly={disabled}
            onChange={(event) => patch({ labels: event.target.value })}
            onBlur={() => void flush()}
          />
        </label>
      </div>
    </>
  );
}
