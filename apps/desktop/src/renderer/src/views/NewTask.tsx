import { useSpaceProjects } from "../lib/space-queries";
import { useRef, useState, type ReactNode } from "react";
import { FolderPlus, GitBranch } from "../components/icons";
import type { TaskPriority, WorkspaceMode } from "@openorc/protocol";
import type { DocumentEditorHandle } from "../components/DocumentEditor";
import { Button, Empty, Input, TextButton } from "../components/ui";
import { readDraft, removeDraft, writeDraft } from "../lib/drafts";
import { useProjectGit } from "../lib/project-git";
import { useRpc, useRpcMutation } from "../lib/client";
import { openTask, openThread } from "../lib/router";
import { useUi } from "../lib/ui";
import { TaskNewPage } from "../components/task-list/TaskNewPage";
import { TaskNewFields } from "../components/task-list/TaskNewFields";
import { OnlineNewTask } from "../components/task-online/NewTask";
import { useTaskOnlineScope } from "../lib/task-online-query";
import { ExecutionLocationSelect } from "../components/TaskExecutionSettings";
import { TaskContentGate } from "../components/task-online/TaskContentGate";

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
        <p>Add a project to create your first task.</p>
        <Button className="mt-4" onClick={input.importProject}>
          <FolderPlus size={14} /> Add project
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
      <summary className="text-sm text-ink-3 hover:text-ink select-none">Execution settings</summary>
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
  return (
    <TaskContentGate>
      <NewTaskSource projectId={projectId} threadId={threadId} />
    </TaskContentGate>
  );
}

function NewTaskSource({ projectId, threadId }: { projectId?: string; threadId?: string }) {
  const { scope, status } = useTaskOnlineScope();
  // A Personal task is this Mac's, as it always was; its cloud agents add tasks of their own beside it.
  if (scope && !scope.personal) return <OnlineNewTask key={JSON.stringify([scope.accountId, scope.spaceId, projectId, threadId])} scope={scope} projectId={projectId} threadId={threadId} />;
  if (status.isLoading) return <div className="document-skeleton" aria-label="Loading projects" />;
  if (status.error)
    return (
      <Empty title="Projects couldn’t load">
        <Button onClick={() => void status.refetch()}>Try again</Button>
      </Empty>
    );
  return <LocalNewTask projectId={projectId} threadId={threadId} />;
}

function LocalNewTask({ projectId, threadId }: { projectId?: string; threadId?: string }) {
  const projects = useSpaceProjects(true);
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
    <TaskNewPage
      draftStored={draftStored}
      gate={projectGate}
      submit={() => void submit()}
      pending={create.isPending}
      disabled={!settings.data || Boolean(threadId && !thread.data) || !draft.title.trim() || !project || create.isPending || !imagesReady}
      footer={<LocalTaskFooter settingsError={settings.error} createError={create.error} retry={() => void settings.refetch()} />}
    >
      <TaskNewFields
        draft={draft}
        patch={patch}
        body={body}
        selectedId={selectedId}
        projects={projects.data}
        projectLocked={Boolean(threadId)}
        onProject={(id) => patch({ projectId: id, baseRef: "" })}
        pending={create.isPending}
        onReady={setImagesReady}
        basePath={project?.rootPath}
        source={
          threadId ? (
            <TextButton type="button" tone="muted" className="text-sm mb-5 truncate max-w-full" onClick={() => openThread(threadId)}>
              From {thread.data?.title ?? "thread"}
            </TextButton>
          ) : null
        }
      />
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
    </TaskNewPage>
  );
}

function LocalTaskFooter({ settingsError, createError, retry }: { settingsError: Error | null; createError: Error | null; retry(): void }) {
  return (
    <>
      {settingsError ? (
        <p role="alert" className="text-sm text-bad">
          Could not load workspace preferences. <TextButton onClick={retry}>Retry</TextButton>
        </p>
      ) : null}
      {createError ? (
        <p role="alert" className="text-sm text-bad mt-1 break-words">
          {createError.message}
        </p>
      ) : null}
    </>
  );
}
