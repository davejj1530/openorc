import { Plus } from "../components/icons";
import { useState } from "react";
import { TopBar } from "../components/TopBar";
import { Button, Empty, Field, IconButton, Input, Segmented, Textarea, Tooltip } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/query";
import { newThread, useRouter } from "../lib/router";
import { WORKSPACE_ID } from "@openorc/protocol";
import { TaskRows } from "./TaskList";

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
          <Button size="sm" onClick={onNewTask}>
            <Plus size={13} /> New task
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
          <Tooltip label="New task">
            <IconButton aria-label="New task" onClick={onNewTask}>
              <Plus size={16} />
            </IconButton>
          </Tooltip>
        }
      >
        Project
        <span className="text-sm font-normal text-ink-3 font-mono truncate">{p.rootPath}</span>
      </TopBar>
      <div className="sub-header">
        <Segmented label="Project section" value={tab} onChange={setTab} options={projectTabs} />
      </div>
      {tab === "tasks" ? taskContent : <ProjectSettings projectId={p.id} />}
    </>
  );
}

function ProjectSettings({ projectId }: { projectId: string }) {
  const project = useRpc("projects.get", { id: projectId });
  const update = useRpcMutation("projects.updateSettings");
  const p = project.data;
  const [setupScript, setSetupScript] = useState<string | null>(null);
  const [include, setInclude] = useState<string | null>(null);
  const [prefix, setPrefix] = useState<string | null>(null);
  if (!p) return null;
  const s = p.settings;

  return (
    <div className="p-5 max-w-xl overflow-y-auto">
      <div className="text-sm text-ink-3 mb-4">
        Default branch <span className="font-mono text-ink-2">{p.defaultBranch ?? "unknown"}</span>
        {p.gitRemote ? (
          <>
            {" "}
            · remote <span className="font-mono text-ink-2">{p.gitRemote}</span>
          </>
        ) : null}
        {s.detectedConfigs.length > 0 ? (
          <>
            {" "}
            · found <span className="font-mono text-ink-2">{s.detectedConfigs.join(", ")}</span>
          </>
        ) : null}
      </div>
      <Field label="Branch prefix" hint="Task branches are named prefix/slug-id.">
        <Input value={prefix ?? s.branchPrefix} onChange={(e) => setPrefix(e.target.value)} />
      </Field>
      <Field label="Copy these gitignored files into new worktrees" hint="One pattern per line, gitignore syntax. .env files by default.">
        <Textarea rows={3} className="font-mono" value={include ?? s.worktreeInclude.join("\n")} onChange={(e) => setInclude(e.target.value)} />
      </Field>
      <Field label="Setup script" hint="Runs in the new worktree before the agent starts. OPENORC_PORT, OPENORC_WORKSPACE_PATH, and OPENORC_ROOT_PATH are set.">
        <Textarea rows={4} className="font-mono" placeholder="pnpm install --frozen-lockfile" value={setupScript ?? s.setupScript ?? ""} onChange={(e) => setSetupScript(e.target.value)} />
      </Field>
      <Button
        disabled={update.isPending}
        onClick={() =>
          update.mutate(
            {
              id: p.id,
              settings: {
                branchPrefix: (prefix ?? s.branchPrefix).trim() || "openorc",
                worktreeInclude: (include ?? s.worktreeInclude.join("\n"))
                  .split("\n")
                  .map((l) => l.trim())
                  .filter(Boolean),
                setupScript: (setupScript ?? s.setupScript ?? "").trim() || null,
              },
            },
            {
              onSuccess: () => {
                setPrefix(null);
                setInclude(null);
                setSetupScript(null);
              },
            },
          )
        }
      >
        Save settings
      </Button>
      {update.error ? <div className="text-sm text-bad mt-2">{update.error.message}</div> : null}
    </div>
  );
}
