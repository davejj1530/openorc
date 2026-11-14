import type { ReactNode } from "react";
import type { Task } from "@openorc/protocol";
import { useRouter, type TaskTab } from "../../lib/router";
import { PageCrumbs } from "../PageTitle";
import { StatusIcon } from "../status";
import { TabTrack } from "../TabTrack";
import { TopBar } from "../TopBar";

export const taskTabs: { id: TaskTab; label: string }[] = [
  { id: "spec", label: "Overview" },
  { id: "chat", label: "Activity" },
  { id: "files", label: "Changes" },
  { id: "commits", label: "Commits" },
  { id: "memory", label: "Memory" },
];

export function TaskWorkspace({
  task,
  tab,
  panel = false,
  selectTab,
  children,
  unavailableTitle = "Loading task…",
}: {
  task?: Pick<Task, "title" | "status">;
  tab: TaskTab;
  panel?: boolean;
  selectTab(tab: TaskTab): void;
  children: ReactNode;
  unavailableTitle?: string;
}) {
  return (
    <main className="task-workspace workspace-main well flex-1 min-w-0 flex flex-col">
      <TopBar panel={panel}>
        <PageCrumbs parent="Tasks" onParent={() => useRouter.getState().navigate({ view: "tasks" })}>
          {task ? (
            <>
              <StatusIcon status={task.status} />
              <span className="truncate" data-tip={task.title}>
                {task.title}
              </span>
            </>
          ) : (
            <span>{unavailableTitle}</span>
          )}
        </PageCrumbs>
      </TopBar>
      {task ? (
        <>
          <div className="task-tabs">
            <TabTrack label="Task workspace" items={taskTabs} value={tab} panelId="task-tab-content" onSelect={selectTab} />
          </div>
          <div id="task-tab-content" role="tabpanel" aria-label={taskTabs.find((item) => item.id === tab)?.label} className="task-tab-content flex-1 min-h-0 flex flex-col" data-tab={tab}>
            {tab === "spec" || tab === "files" ? children : <div className="task-tab-body">{children}</div>}
          </div>
        </>
      ) : (
        children
      )}
    </main>
  );
}
