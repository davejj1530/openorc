import type { TaskOnlineScope } from "../../lib/task-online-query";
import { useNewOnlineTask } from "../../lib/task-new-online";
import { TaskNewPage } from "../task-list/TaskNewPage";
import { TaskNewFields } from "../task-list/TaskNewFields";
import { Button, Empty } from "../ui";
import { TaskAssignee } from "./TaskAssignee";
import { Lock } from "../icons";

export function OnlineNewTask({ scope, projectId, threadId }: { scope: TaskOnlineScope; projectId?: string; threadId?: string }) {
  const task = useNewOnlineTask(scope, projectId, threadId);
  let gate = null;
  if (task.projects.isLoading) gate = <div className="document-skeleton" aria-label="Loading projects" />;
  else if (task.projects.error)
    gate = (
      <Empty title="Projects couldn’t load">
        <Button onClick={() => void task.projects.refetch()}>Try again</Button>
      </Empty>
    );
  else if (!task.selected)
    gate = (
      <Empty title="No projects yet">
        <p>Add a project to create a task in this space.</p>
      </Empty>
    );
  return (
    <TaskNewPage
      draftStored={task.stored}
      gate={gate}
      submit={() => void task.submit()}
      pending={task.pending}
      disabled={task.pending || !task.draft.title.trim() || !task.selected || !task.imagesReady}
      footer={
        task.error ? (
          <p role="alert" className="text-sm text-bad mt-1 break-words">
            {task.error}
          </p>
        ) : null
      }
    >
      <TaskNewFields
        draft={task.draft}
        patch={task.patch}
        body={task.body}
        selectedId={task.selected?.hostedProjectId ?? ""}
        projects={task.eligible.flatMap((project) => (project.hostedProjectId ? [{ id: project.hostedProjectId, name: project.name }] : []))}
        projectLocked={Boolean(task.source)}
        onProject={(id) => {
          task.patch({ projectId: id });
          task.setAssignee(null);
        }}
        pending={task.pending}
        locked={task.locked}
        onReady={task.setImagesReady}
        assignee={
          task.selected?.hostedProjectId ? (
            <TaskAssignee scope={scope} projectId={task.selected.hostedProjectId} value={task.assignee} onChange={task.setAssignee} disabled={task.pending || task.locked} />
          ) : null
        }
        source={
          threadId ? (
            <p className="text-sm mb-5 text-ink-3 inline-flex items-center gap-1.5">
              {task.source ? (
                `From ${task.source.title}`
              ) : (
                <>
                  <Lock size={12} />
                  Private thread
                </>
              )}
            </p>
          ) : null
        }
        imageUnavailableReason="Images aren’t available in shared task documents yet."
      />
    </TaskNewPage>
  );
}
