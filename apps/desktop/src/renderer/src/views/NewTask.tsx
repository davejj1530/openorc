import { useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, CircleDashed, FolderGit2, GitBranch, Plus } from "../components/icons";
import type { TaskPriority, WorkspaceMode } from "@openorc/protocol";
import { DocumentEditor, type DocumentEditorHandle } from "../components/DocumentEditor";
import { PriorityIcon, priorityLabel, priorityOrder } from "../components/status";
import { TopBar } from "../components/TopBar";
import { Button, Empty, IconButton, Input, Kbd, Select, TextButton } from "../components/ui";
import { readDraft, removeDraft, writeDraft } from "../lib/drafts";
import { useProjectGit } from "../lib/project-git";
import { useRpc, useRpcMutation } from "../lib/query";
import { newThread, openTask, openThread, useRouter } from "../lib/router";
import { useUi } from "../lib/ui";
import { ExecutionLocationSelect } from "../components/TaskExecutionSettings";

function newTaskProjectGate(input: { error: Error | null; loading: boolean; empty: boolean; retry: () => void; importProject: () => void }): ReactNode {
  if (input.error)
    return (
      <Empty title="Projects couldn’t load">
        <Button onClick={input.retry}>Try again</Button>
      </Empty>
    );
  if (input.loading) return <div className="document-skeleton" aria-label="Loading projects" />;
  if (input.empty) {
    return (
      <Empty title="Give your work a home">
        <p>Import a project to create your first task.</p>
        <Button className="mt-4" onClick={input.importProject}>
          <FolderGit2 size={14} /> Import project
        </Button>
      </Empty>
    );
  }
  return null;
}

function workspaceHint(linkedThread: boolean, useWorktree: boolean): string {
  if (linkedThread) return "Uses the linked conversation’s location. Change it on the saved task to move the conversation.";
  if (useWorktree) return "A workspace is prepared when work starts in the new thread.";
  return "The thread will use your current checkout when you start work.";
}

/** A new task's worktree choice: a linked thread decides, then the draft, then the saved default, never before the project can branch. */
function taskUsesWorktree(input: {
  linked: boolean;
  thread: { workspaceMode: WorkspaceMode } | null | undefined;
  chosen: boolean | undefined;
  preferred: WorkspaceMode | undefined;
  canBranch: boolean;
}): boolean {
  if (input.linked) return input.thread?.workspaceMode === "worktree";
  return input.canBranch && (input.chosen ?? input.preferred === "worktree");
}

/** Where a new task will work, and the branch its worktree starts from. */
function NewTaskLocation(props: {
  linked: boolean;
  worktree: boolean;
  worktreeBlocked: boolean;
  settingsReady: boolean;
  baseRef: string;
  defaultBranch: string | null | undefined;
  onWorktree: (worktree: boolean) => void;
  onBaseRef: (baseRef: string) => void;
}) {
  return (
    <details className="task-execution-settings">
      <summary className="cursor-pointer text-sm text-ink-3 hover:text-ink select-none">Execution settings</summary>
      <div className="grid gap-4 mt-4">
        <ExecutionLocationSelect
          value={props.worktree ? "worktree" : "current"}
          disabled={!props.settingsReady || props.linked}
          worktreeBlocked={props.worktreeBlocked}
          onChange={(value) => props.onWorktree(value === "worktree")}
        />
        <label className="flex items-center gap-2 min-w-0 text-ink-3">
          <GitBranch size={14} />
          <span className="text-sm shrink-0">Base branch</span>
          <Input
            aria-label="Base branch"
            disabled={!props.worktree || props.linked}
            className="max-w-64"
            placeholder={props.defaultBranch ?? "main"}
            value={props.baseRef}
            onChange={(e) => props.onBaseRef(e.target.value)}
          />
        </label>
        <p className="text-sm text-ink-3">{workspaceHint(props.linked, props.worktree)}</p>
      </div>
    </details>
  );
}

export function NewTask({ projectId, threadId }: { projectId?: string; threadId?: string }) {
  const projects = useRpc("projects.list", {});
  const thread = useRpc("threads.get", { id: threadId ?? "" }, { enabled: Boolean(threadId) });
  const settings = useRpc("app.settings.get", {});
  const create = useRpcMutation("tasks.create");
  const key = `newtask.${projectId ?? "all"}.${threadId ?? "none"}`;
  const [draft, setDraft] = useState(() =>
    readDraft(key, { title: "", spec: "", projectId: projectId ?? "", priority: "none" as TaskPriority, baseRef: "", useWorktree: undefined as boolean | undefined }),
  );
  const submitting = useRef(false);
  const body = useRef<DocumentEditorHandle>(null);
  const current = useRef(draft);
  current.current = draft;
  const [imagesReady, setImagesReady] = useState(true);
  const [draftStored, setDraftStored] = useState(true);
  const patch = (value: Partial<typeof draft>) => {
    const next = { ...current.current, ...value };
    current.current = next;
    setDraft(next);
    setDraftStored(writeDraft(key, next));
  };
  const selectedId = draft.projectId || projectId || projects.data?.[0]?.id || "";
  const project = projects.data?.find((p) => p.id === selectedId);
  const git = useProjectGit(selectedId);
  const useWorktree = taskUsesWorktree({ linked: Boolean(threadId), thread: thread.data, chosen: draft.useWorktree, preferred: settings.data?.defaultWorkspaceMode, canBranch: !git.cannotBranch });
  const projectGate = newTaskProjectGate({
    error: projects.error,
    loading: projects.isLoading,
    empty: projects.data?.length === 0,
    retry: () => void projects.refetch(),
    importProject: () => useUi.getState().setImportProject(true),
  });
  const back = () => useRouter.getState().back();
  const submit = async () => {
    if (!project || !settings.data || (threadId && !thread.data) || !draft.title.trim() || submitting.current) return;
    submitting.current = true;
    try {
      if (body.current && !(await body.current.flush())) return;
      const snapshot = current.current;
      const task = await create.mutateAsync({
        projectId: project.id,
        threadId,
        title: snapshot.title.trim(),
        spec: snapshot.spec.trim() || undefined,
        priority: snapshot.priority,
        baseRef: snapshot.baseRef.trim() || undefined,
        useWorktree: taskUsesWorktree({ linked: Boolean(threadId), thread: thread.data, chosen: snapshot.useWorktree, preferred: settings.data.defaultWorkspaceMode, canBranch: !git.cannotBranch }),
      });
      removeDraft(key);
      openTask(task.id, "spec");
    } catch {
      /* Error stays with the draft so the user can retry. */
    } finally {
      submitting.current = false;
    }
  };
  return (
    <div className="task-workspace h-full flex flex-col min-h-0">
      <TopBar
        projectId={selectedId || undefined}
        projectName={project?.name}
        onProjectChange={(id) => {
          if (threadId) newThread(id ?? undefined);
          else if (id && projects.data?.some((p) => p.id === id)) patch({ projectId: id, baseRef: "" });
          else newThread(id ?? undefined);
        }}
        actions={
          <span className={`text-sm inline-flex items-center gap-1.5 ${draftStored ? "text-ink-3" : "text-bad"}`} role="status">
            {draftStored ? (
              <>
                <Check size={12} /> Draft saved locally
              </>
            ) : (
              "Local draft couldn’t be saved. Keep this page open."
            )}
          </span>
        }
      >
        <IconButton onClick={back} aria-label="Back">
          <ArrowLeft size={15} />
        </IconButton>
        <TextButton tone="muted" onClick={() => useRouter.getState().navigate({ view: "tasks" })}>
          Tasks
        </TextButton>
        <span className="text-ink-4">/</span>
        <span className="truncate">New task</span>
      </TopBar>
      {projectGate ?? (
        <form
          className="flex-1 min-h-0 flex flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
        >
          <div className="task-scroll">
            <div className="task-document">
              <textarea
                autoFocus
                rows={1}
                aria-label="Task title"
                className="document-title"
                placeholder="Task title"
                value={draft.title}
                onChange={(e) => patch({ title: e.target.value.replace(/\n/g, " ") })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
                    e.preventDefault();
                    body.current?.focus();
                  }
                }}
              />
              <div className="task-properties" aria-label="Task properties">
                <span className="property-chip">
                  <CircleDashed size={14} /> Backlog
                </span>
                <label className="property-chip">
                  <PriorityIcon priority={draft.priority} />
                  <Select aria-label="Priority" className="property-select" value={draft.priority} onChange={(e) => patch({ priority: e.target.value as TaskPriority })}>
                    {priorityOrder.map((p) => (
                      <option key={p} value={p}>
                        {priorityLabel[p]}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="property-chip min-w-0">
                  <FolderGit2 size={14} className="shrink-0" />
                  <Select aria-label="Project" className="property-select" value={selectedId} disabled={Boolean(threadId)} onChange={(e) => patch({ projectId: e.target.value, baseRef: "" })}>
                    {projects.data?.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>
              {threadId ? (
                <TextButton type="button" tone="muted" className="text-sm mb-5 truncate max-w-full" onClick={() => openThread(threadId)}>
                  From {thread.data?.title ?? "thread"}
                </TextButton>
              ) : null}
              <DocumentEditor ref={body} value={draft.spec} onChange={(spec) => patch({ spec })} onReadyChange={setImagesReady} disabled={create.isPending} basePath={project?.rootPath} />
              <NewTaskLocation
                linked={Boolean(threadId)}
                worktree={useWorktree}
                worktreeBlocked={git.cannotBranch}
                settingsReady={Boolean(settings.data)}
                baseRef={draft.baseRef}
                defaultBranch={project?.defaultBranch}
                onWorktree={(worktree) => patch({ useWorktree: worktree })}
                onBaseRef={(baseRef) => patch({ baseRef })}
              />
            </div>
          </div>
          <footer className="document-footer">
            <div className="min-w-0">
              <p className="text-sm text-ink-3">Saves to backlog. Continue in a thread when you’re ready.</p>
              {settings.error ? (
                <p role="alert" className="text-sm text-bad">
                  Could not load workspace preferences. <TextButton onClick={() => void settings.refetch()}>Retry</TextButton>
                </p>
              ) : null}
              {create.error ? (
                <p role="alert" className="text-sm text-bad mt-1 break-words">
                  {create.error.message}
                </p>
              ) : null}
            </div>
            <Button type="submit" disabled={!settings.data || Boolean(threadId && !thread.data) || !draft.title.trim() || !project || create.isPending || !imagesReady}>
              <Plus size={14} />
              {create.isPending ? "Creating…" : "Create task"}
              <Kbd>⌘↵</Kbd>
            </Button>
          </footer>
        </form>
      )}
    </div>
  );
}
