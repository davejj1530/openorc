import { TaskStatus } from "@openorc/protocol";
import { cn } from "../../lib/cn";
import { openTaskRecord } from "../../lib/task-open";
import { useTaskProperty } from "../../lib/task-property";
import type { TaskRecord } from "../../lib/task-records";
import { useScrollEdges } from "../../lib/use-scroll-edges";
import { useWindowsControls } from "../../lib/window";
import { Maximize2, X } from "../icons";
import { StatusIcon, statusLabel, statusOrder } from "../status";
import { RunFact } from "../task-board/TeamRun";
import { TaskAssignee } from "../task-online/TaskAssignee";
import { TaskOnlineHistory } from "../task-online/TaskHistory";
import { TaskThreadLink } from "../task-online/TaskThreadLink";
import { IconButton, Select, Tooltip } from "../ui";
import { TASK_PANE_ID } from "./task-pane";

type OnlineRecord = Extract<TaskRecord, { kind: "online" }>;

/**
 * A team task beside the board, as its page has it: its status, which is set here too, who it is assigned to, where its
 * work runs and the way to its thread, then its activity.
 */
export function OnlineTaskPane({ record, onClose }: { record: OnlineRecord; onClose: () => void }) {
  const windowsControls = useWindowsControls();
  const edges = useScrollEdges();
  const update = useTaskProperty(record.reference, record.task);
  const task = update.state.task;
  const disabled = update.pending || !task.viewer.mayEdit;
  return (
    <>
      <header className={cn("task-pane-head drag-region", windowsControls && "pr-controls")}>
        <StatusIcon status={task.status} />
        <h2 id={`${TASK_PANE_ID}-title`} className="task-pane-title truncate" data-tip={task.title}>
          {task.title}
        </h2>
        <div className="task-pane-actions">
          <Tooltip label="Open the full page">
            <IconButton aria-label="Open the full page" onClick={() => openTaskRecord(record)}>
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
        <div className="task-pane-properties" aria-label="Task properties">
          <label className="property-chip">
            <StatusIcon status={task.status} />
            <Select
              aria-label="Status"
              className="property-select"
              value={task.status}
              disabled={disabled}
              onChange={(event) => void update.controller.property({ status: TaskStatus.parse(event.target.value) })}
            >
              {statusOrder.map((value) => (
                <option key={value} value={value}>
                  {statusLabel[value]}
                </option>
              ))}
            </Select>
          </label>
          {task.organizationId ? (
            <TaskAssignee
              scope={record.reference}
              projectId={record.reference.projectId}
              value={task.assignee}
              disabled={disabled}
              onChange={(person) => void update.controller.property({ assigneeMemberId: person?.memberId ?? null })}
            />
          ) : null}
          <span className="task-pane-where">
            <RunFact task={task} />
          </span>
          <span className="task-pane-open">
            <TaskThreadLink reference={record.reference} task={task} />
          </span>
        </div>
        {update.state.propertyError ? (
          <p role="alert" className="task-pane-error">
            Couldn’t save: {update.state.propertyError}
          </p>
        ) : null}
        <div {...edges} className="task-pane-history scroll-edges">
          <TaskOnlineHistory reference={record.reference} task={task} />
        </div>
      </div>
    </>
  );
}
