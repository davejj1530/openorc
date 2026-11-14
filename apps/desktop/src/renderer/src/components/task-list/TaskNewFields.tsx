import type { ReactNode, RefObject } from "react";
import { TaskPriority } from "@openorc/protocol";
import { DocumentEditor, type DocumentEditorHandle } from "../DocumentEditor";
import { FolderGit2 } from "../icons";
import { PriorityIcon, StatusIcon, priorityLabel, priorityOrder } from "../status";
import { Select } from "../ui";

type Draft = { title: string; spec: string; priority: TaskPriority };
export function TaskNewFields({
  draft,
  patch,
  body,
  selectedId,
  projects,
  projectLocked,
  onProject,
  pending,
  onReady,
  basePath,
  assignee,
  source,
  imageUnavailableReason,
  locked = false,
}: {
  draft: Draft;
  patch(value: Partial<Draft>): void;
  body: RefObject<DocumentEditorHandle | null>;
  selectedId: string;
  projects: { id: string; name: string }[] | undefined;
  projectLocked: boolean;
  onProject(id: string): void;
  pending: boolean;
  onReady(ready: boolean): void;
  basePath?: string;
  assignee?: ReactNode;
  source?: ReactNode;
  imageUnavailableReason?: string;
  locked?: boolean;
}) {
  return (
    <>
      <textarea
        autoFocus
        rows={1}
        aria-label="Task title"
        className="document-title native-field"
        placeholder="Task title"
        value={draft.title}
        readOnly={locked}
        onChange={(event) => patch({ title: event.target.value.replace(/\n/g, " ") })}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
            event.preventDefault();
            body.current?.focus();
          }
        }}
      />
      <div className="task-properties" aria-label="Task properties">
        {assignee}
        <span className="property-chip">
          <StatusIcon status="backlog" />
          Backlog
        </span>
        <label className="property-chip">
          <PriorityIcon priority={draft.priority} />
          <Select aria-label="Priority" className="property-select" value={draft.priority} disabled={locked} onChange={(event) => patch({ priority: TaskPriority.parse(event.target.value) })}>
            {priorityOrder.map((priority) => (
              <option key={priority} value={priority}>
                {priorityLabel[priority]}
              </option>
            ))}
          </Select>
        </label>
        <label className="property-chip min-w-0">
          <FolderGit2 size={14} className="shrink-0" />
          <Select aria-label="Project" className="property-select" value={selectedId} disabled={projectLocked || locked} onChange={(event) => onProject(event.target.value)}>
            {projects?.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {source}
      <DocumentEditor
        ref={body}
        value={draft.spec}
        onChange={(spec) => patch({ spec })}
        onReadyChange={onReady}
        disabled={pending || locked}
        basePath={basePath}
        imageUnavailableReason={imageUnavailableReason}
      />
    </>
  );
}
