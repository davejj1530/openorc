import { Plus } from "../components/icons";
import { useState } from "react";
import { TopBar } from "../components/TopBar";
import { Button, Empty, Segmented } from "../components/ui";
import { useRpc } from "../lib/client";
import { newThread, useRouter } from "../lib/router";
import { WORKSPACE_ID } from "@openorc/protocol";
import { TaskRows } from "./TaskList";
import { ProjectSettings } from "./project-settings";

const projectTabs = [
  { value: "tasks", label: "Tasks" },
  { value: "settings", label: "Settings" },
] as const;

export function ProjectView({ projectId, onNewTask }: { projectId: string; onNewTask: () => void }) {
  const project = useRpc("projects.get", { id: projectId });
  const tasks = useRpc("tasks.list", { projectId });
  const [tab, setTab] = useState<"tasks" | "settings">("tasks");
  const p = project.data;
  if (!p) return null;
  const taskContent =
    (tasks.data ?? []).length === 0 && !tasks.isLoading ? (
      <Empty title="No tasks in this project">
        Create one to start an agent in a fresh worktree.
        <div className="mt-3">
          <Button size="lg" onClick={onNewTask}>
            <Plus size={14} className="text-ink-3" /> New task
          </Button>
        </div>
      </Empty>
    ) : (
      <TaskRows tasks={tasks.data ?? []} showProject={false} />
    );

  return (
    <>
      <TopBar
        projectId={p.id}
        projectName={p.name}
        onProjectChange={(id) => {
          if (id && id !== WORKSPACE_ID) useRouter.getState().navigate({ view: "project", projectId: id });
          else newThread(id ?? undefined);
        }}
        actions={
          <span className="flex items-center gap-2">
            <Segmented label="Project section" size="sm" value={tab} onChange={setTab} options={projectTabs} />
            <Button size="lg" onClick={onNewTask}>
              <Plus size={14} className="text-ink-3" /> New task
            </Button>
          </span>
        }
      >
        <span className="inline-flex h-7 shrink-0 items-center px-1 text-ink">Project</span>
        <span className="text-sm text-ink-4 font-mono truncate">{p.rootPath}</span>
      </TopBar>
      {tab === "tasks" ? taskContent : <ProjectSettings projectId={p.id} />}
    </>
  );
}
