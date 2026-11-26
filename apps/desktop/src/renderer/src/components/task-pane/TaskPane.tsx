import { TaskStatus, type Project, type Task } from "@openorc/protocol";
import { cn } from "../../lib/cn";
import { useRpc, useRpcMutation } from "../../lib/client";
import { pullRequestTone, pullRequestToneLabel } from "../../lib/pull-requests";
import { openPullRequest } from "../../lib/router";
import { openTaskRecord } from "../../lib/task-open";
import { localTaskRecord, taskRecordKey, type TaskRecord } from "../../lib/task-records";
import { useScrollEdges } from "../../lib/use-scroll-edges";
import { useWindowsControls } from "../../lib/window";
import { AutomationsMenu } from "../automations/AutomationsMenu";
import { GitBranch, GitPullRequest, Maximize2, X } from "../icons";
import { PullStateGlyph } from "../PullStateGlyph";
import { StatusIcon, statusLabel, statusOrder } from "../status";
import { TaskTimeline } from "../TaskTimeline";
import { IconButton, Select, Tooltip } from "../ui";
import { OnlineTaskPane } from "./OnlineTaskPane";
import { TASK_PANE_ID, taskPullRequest, useHeldThroughClose } from "./task-pane";
import "./task-pane.css";

/** The task's pull request as GitHub has it now: its state's mark and its number, and the way to it. */
function PullRequestChip({ projectId, number }: { projectId: string; number: number }) {
  const pull = useRpc("pulls.get", { projectId, number });
  const tone = pull.data ? pullRequestTone(pull.data) : null;
  return (
    <button
      type="button"
      className="property-chip task-pane-pull"
      aria-label={`Pull request ${number}${tone ? `, ${pullRequestToneLabel[tone]}` : ""}`}
      onClick={() => openPullRequest(projectId, number)}
    >
      {tone ? <PullStateGlyph state={tone} /> : <GitPullRequest size={14} />}
      <span className="tabular">#{number}</span>
    </button>
  );
}

/** What the task page says of a task under its title: its status, which is set here too, where it works, and its pull request. */
function TaskPaneProperties({ task, pull }: { task: Task; pull: number | null }) {
  const update = useRpcMutation("tasks.update");
  const thread = useRpc("tasks.executionThread", { taskId: task.id }).data;
  const mode = thread?.workspaceMode ?? task.workspaceMode;
  const branch = thread ? thread.branch : task.branch;
  return (
    <>
      <div className="task-pane-properties" aria-label="Task properties">
        <label className="property-chip">
          <StatusIcon status={task.status} />
          <Select
            aria-label="Status"
            className="property-select"
            value={task.status}
            disabled={update.isPending}
            onChange={(event) => update.mutate({ id: task.id, patch: { status: TaskStatus.parse(event.target.value) } })}
          >
            {statusOrder.map((value) => (
              <option key={value} value={value}>
                {statusLabel[value]}
              </option>
            ))}
          </Select>
        </label>
        <span className="property-chip" data-tip={branch ?? undefined}>
          <GitBranch size={14} />
          {mode === "worktree" ? "Worktree" : "Local checkout"}
        </span>
        {pull ? <PullRequestChip projectId={task.projectId} number={pull} /> : null}
      </div>
      {update.error ? (
        <p role="alert" className="task-pane-error">
          Couldn’t save: {update.error.message}
        </p>
      ) : null}
    </>
  );
}

function TaskPaneContent({ task, project, onClose }: { task: Task; project: Project | undefined; onClose: () => void }) {
  const windowsControls = useWindowsControls();
  const events = useRpc("tasks.events", { taskId: task.id });
  const edges = useScrollEdges();
  return (
    <>
      <header className={cn("task-pane-head drag-region", windowsControls && "pr-controls")}>
        <StatusIcon status={task.status} />
        <h2 id={`${TASK_PANE_ID}-title`} className="task-pane-title truncate" data-tip={task.title}>
          {task.title}
        </h2>
        <div className="task-pane-actions">
          {project?.rootPath ? <AutomationsMenu projectId={project.id} task={task} /> : null}
          <Tooltip label="Open the full page">
            <IconButton aria-label="Open the full page" onClick={() => openTaskRecord(localTaskRecord(task))}>
              <Maximize2 size={16} />
            </IconButton>
          </Tooltip>
          <Tooltip label="Close">
            <IconButton aria-label="Close" onClick={onClose}>
              <X size={16} />
            </IconButton>
          </Tooltip>
        </div>
      </header>
      <div className="task-pane-body">
        <TaskPaneProperties task={task} pull={taskPullRequest(events.data ?? [])} />
        <div {...edges} className="task-pane-history scroll-edges">
          <TaskTimeline taskId={task.id} projectId={task.projectId} />
        </div>
      </div>
    </>
  );
}

/**
 * The task of the card that is open on the board, beside the board: its status mark and title over the way to its full
 * page and Close, its properties, then its history, where an agent's update is answered as on the task's own page; a
 * team's task shows its own. With no task it is shut, and it keeps the last one in view while it closes.
 */
export function TaskPane({ record, project, onClose }: { record: TaskRecord | null; project: Project | undefined; onClose: () => void }) {
  const shown = useHeldThroughClose(record);
  return (
    <div className="task-pane-shell" data-open={Boolean(record)}>
      {shown ? (
        <aside id={TASK_PANE_ID} className="task-pane" aria-labelledby={`${TASK_PANE_ID}-title`} inert={!record}>
          {shown.kind === "local" ? (
            <TaskPaneContent key={taskRecordKey(shown)} task={shown.task} project={project} onClose={onClose} />
          ) : (
            <OnlineTaskPane key={taskRecordKey(shown)} record={shown} onClose={onClose} />
          )}
        </aside>
      ) : null}
    </div>
  );
}
