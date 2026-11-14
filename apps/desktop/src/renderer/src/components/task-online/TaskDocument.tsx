import { useImperativeHandle, type Ref } from "react";
import type { OnlineTaskRef } from "@openorc/protocol";
import type { useTaskOnlineSave } from "../../lib/task-online-save";
import { useTaskDocumentDraft } from "../../lib/task-document-draft";
import { taskRefKey } from "../../lib/task-ref";
import { TaskDocumentFields } from "../task-list/TaskDocumentFields";
import { taskDraftStatus, type TaskDocumentHandle } from "../../views/TaskDocument";
import { ArrowUpRight } from "../icons";
import { Button, Tooltip } from "../ui";
import { TaskAssignee } from "./TaskAssignee";
import { TaskSaveConflict } from "./TaskSaveConflict";
import { TaskLinks } from "./TaskLinks";
import { TaskOnlineDelete } from "./TaskDelete";

export function OnlineTaskDocument({
  reference,
  projectName,
  save,
  ref,
}: {
  reference: OnlineTaskRef;
  projectName: string;
  save: ReturnType<typeof useTaskOnlineSave>;
  ref?: Ref<TaskDocumentHandle>;
}) {
  const { controller, state, pending } = save;
  const task = state.task;
  const document = useTaskDocumentDraft(task, {
    storageId: taskRefKey(reference),
    save: { mutateAsync: ({ patch }) => controller.save(patch), isPending: state.saving, error: state.error, edited: save.edited, clean: save.clean },
  });
  const { draft, flush } = document;
  useImperativeHandle(ref, () => ({ flush }));
  const saveMine = () => {
    controller.allowOverwrite();
    void flush();
  };
  return (
    <div
      className="flex-1 min-h-0 flex flex-col"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && (event.key === "Enter" || event.key.toLowerCase() === "s")) {
          event.preventDefault();
          void flush();
        }
      }}
    >
      <div className="task-scroll">
        <article className="task-document">
          <TaskDocumentFields
            document={document}
            status={task.status}
            priority={task.priority}
            projectName={projectName}
            pending={pending}
            disabled={!task.viewer.mayEdit}
            error={state.propertyError}
            assignee={
              <TaskAssignee
                scope={reference}
                projectId={reference.projectId}
                value={task.assignee}
                disabled={pending || !task.viewer.mayEdit}
                onChange={(person) => void controller.property({ assigneeMemberId: person?.memberId ?? null })}
              />
            }
            imageUnavailableReason="Images aren’t available in shared task documents yet."
            onStatus={(status) => void controller.property({ status })}
            onPriority={(priority) => void controller.property({ priority })}
          />
          <TaskLinks task={task} beforeOpen={flush} />
          <TaskOnlineDelete task={task} beforeDelete={flush} getTask={() => controller.getSnapshot().task} pending={pending} />
        </article>
      </div>
      <footer className="document-footer">
        {state.conflict ? (
          <TaskSaveConflict current={state.conflict} pending={pending} useSaved={() => document.replaceSaved(controller.useSavedVersion())} saveMine={() => void saveMine()} />
        ) : (
          <div className="text-sm text-ink-3 min-w-0" role="status">
            {taskDraftStatus({
              draftStored: document.draftStored,
              saveError: document.saveError,
              flushError: document.error,
              hasTitle: Boolean(draft.title.trim()),
              imagesReady: document.imagesReady,
              saving: document.saving,
              dirty: document.dirty,
              retry: () => void flush(),
            })}
          </div>
        )}
        <span className="hidden sm:inline-flex text-xs text-ink-3">OpenOrc Cloud</span>
        <Tooltip label={task.execution.state === "unavailable" ? "This task’s thread is unavailable." : "Opening cloud task threads isn’t available yet."}>
          <Button disabled>
            Open thread <ArrowUpRight size={13} />
          </Button>
        </Tooltip>
      </footer>
    </div>
  );
}
