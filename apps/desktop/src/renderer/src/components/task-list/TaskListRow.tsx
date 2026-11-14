import { useId } from "react";
import { Menu } from "@base-ui/react/menu";
import type { Project, Task } from "@openorc/protocol";
import { ownerMark, relativeTime } from "@openorc/client";
import { CoversPreview } from "../../lib/browser-preview";
import { cn } from "../../lib/cn";
import { useRpcMutation } from "../../lib/client";
import { openTask } from "../../lib/router";
import { openTaskRecord } from "../../lib/task-open";
import { taskNeedsYou, type TaskRecord } from "../../lib/task-records";
import { floatingGround } from "../../lib/use-anchor-ground";
import { Check, Cloud } from "../icons";
import { ProjectLogo } from "../ProjectIconPicker";
import { StatusIcon, statusLabel, statusOrder } from "../status";
import { TaskStart } from "../TaskStart";
import { menuItem, menuPopup } from "../menu";
import { Button, IconButton, metaSlot, StatusDot } from "../ui";
import { TaskFacts } from "../task-online/TaskFacts";
import { TaskOnlineOpen, TaskOnlineRowStatus } from "../task-online/TaskRowControls";

function TaskRowStatus({ task, onMoved }: { task: Task; onMoved: () => void }) {
  const update = useRpcMutation("tasks.update");
  const feedbackId = useId();
  return (
    <div className="task-row-status relative shrink-0">
      <Menu.Root>
        <Menu.Trigger
          render={<IconButton aria-label={`Status for ${task.title}`} size="xs" />}
          aria-describedby={update.error || update.isPending ? feedbackId : undefined}
          aria-busy={update.isPending}
          data-tip={`Change status · ${statusLabel[task.status]}`}
          disabled={update.isPending}
        >
          <StatusIcon status={task.status} />
        </Menu.Trigger>
        <Menu.Portal>
          <CoversPreview />
          <Menu.Positioner sideOffset={6} align="start" className="z-40" collisionPadding={8}>
            <Menu.Popup ref={floatingGround} className={menuPopup}>
              {statusOrder.map((status) => (
                <Menu.Item
                  key={status}
                  className={menuItem}
                  onClick={() => {
                    if (status !== task.status) update.mutate({ id: task.id, patch: { status } }, { onSuccess: onMoved });
                  }}
                >
                  <StatusIcon status={status} />
                  <span className="flex-1">{statusLabel[status]}</span>
                  {status === task.status ? <Check size={13} className="text-ink-3" /> : null}
                </Menu.Item>
              ))}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {update.isPending ? (
        <p id={feedbackId} role="status" className="sr-only">
          Saving…
        </p>
      ) : null}
      {update.error ? (
        <p id={feedbackId} role="alert" className="absolute left-0 top-full z-20 mt-1 w-56 rounded-md bg-float-fill px-2.5 py-1.5 text-sm text-bad break-words">
          Couldn’t change status: {update.error.message}
        </p>
      ) : null}
    </div>
  );
}

/** A task's project in its fixed column: the project's mark, then its name. */
function TaskProject({ project }: { project: Project | undefined }) {
  return (
    <span className="task-row-meta task-row-project">
      {project ? (
        <>
          <ProjectLogo project={project} />
          <span className="truncate">{project.name}</span>
        </>
      ) : null}
    </span>
  );
}

/** The row's last column: Review on a task ready for review, the way to its thread before work starts, else nothing. */
function TaskMove({ task }: { task: Task }) {
  return (
    <span className="task-row-move">
      {task.status === "review" ? (
        <Button size="sm" onClick={() => openTask(task.id, "files")}>
          Review
        </Button>
      ) : null}
      {task.status === "backlog" || task.status === "proposed" ? <TaskStart task={task} /> : null}
    </span>
  );
}

/** Where a task the Mac lists from its cloud brain lives, as thread rows say it. */
function TaskOwnerMark({ task }: { task: Task }) {
  const mark = ownerMark({ owner: task.owner, moving: undefined });
  if (!mark) return null;
  return (
    <span className={cn("task-row-meta inline-flex shrink-0 items-center gap-1", mark.dim && "opacity-60")}>
      <Cloud size={12} />
      {mark.label}
    </span>
  );
}

export function TaskListRow({
  record,
  project,
  showProject,
  current,
  onFocus,
  onMoved,
}: {
  record: TaskRecord;
  project: Project | undefined;
  showProject: boolean;
  current: boolean;
  onFocus: () => void;
  onMoved: () => void;
}) {
  const task = record.task;
  return (
    <div data-current={current || undefined} data-status={task.status} className="task-list-row">
      {record.kind === "local" ? <TaskRowStatus task={record.task} onMoved={onMoved} /> : <TaskOnlineRowStatus reference={record.reference} task={record.task} onMoved={onMoved} />}
      <button data-task-open onClick={() => openTaskRecord(record)} tabIndex={current ? 0 : -1} onFocus={onFocus} aria-label={taskRowLabel(record)}>
        <span className="task-row-title" data-tip={task.title}>
          {task.title}
        </span>
        {task.labels[0] ? (
          <span className="task-row-meta task-row-label">
            <StatusDot tone="muted" />
            <span className="truncate">{task.labels[0]}</span>
          </span>
        ) : null}
        {record.kind === "local" ? <TaskOwnerMark task={record.task} /> : <TaskFacts task={record.task} />}
        {showProject ? <TaskProject project={project} /> : null}
        <span className={cn(metaSlot, "task-row-meta task-row-time")}>{relativeTime(task.updatedAt)}</span>
      </button>
      {record.kind === "local" ? (
        <TaskMove task={record.task} />
      ) : (
        <span className="task-row-move">
          {task.status === "review" ? (
            <Button size="sm" onClick={() => openTaskRecord(record, "files")}>
              Review
            </Button>
          ) : null}
          {task.status === "backlog" || task.status === "proposed" ? <TaskOnlineOpen task={record.task} /> : null}
        </span>
      )}
    </div>
  );
}

function taskRowLabel(record: TaskRecord): string {
  const label = `${record.task.title}, ${taskNeedsYou(record) ? "needs your approval" : statusLabel[record.task.status]}`;
  if (record.kind === "local") return label;
  return [label, record.task.assignee ? `Assigned to ${record.task.assignee.name}` : null, record.task.viewer.unseenAssignment ? "New assignment" : null, "OpenOrc Cloud"].filter(Boolean).join(", ");
}
