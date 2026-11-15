import type { OnlineTask } from "@openorc/protocol";
import { AccountFace } from "../AccountFace";
import { Cloud } from "../icons";
import "./tasks.css";

/** Optional facts consume only their own width in the existing metadata strip. The cloud mark is left out when the row's project already draws one. */
export function TaskFacts({ task, cloud = true }: { task: OnlineTask; cloud?: boolean }) {
  return (
    <span className="task-row-meta inline-flex shrink-0 items-center gap-1.5">
      {task.assignee ? (
        <span data-tip={`Assigned to ${task.assignee.name}`}>
          <AccountFace name={task.assignee.name} image={task.assignee.image} className="task-assignee-face" />
          <span className="sr-only">Assigned to {task.assignee.name}. </span>
        </span>
      ) : null}
      {task.viewer.unseenAssignment ? (
        <span className="task-unseen" data-tip="New assignment">
          <span className="sr-only">New assignment. </span>
        </span>
      ) : null}
      {cloud ? (
        <span data-tip="OpenOrc Cloud">
          <Cloud size={12} />
          <span className="sr-only">OpenOrc Cloud</span>
        </span>
      ) : null}
    </span>
  );
}
