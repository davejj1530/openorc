import { useRef, useState } from "react";
import { WORKSPACE_ID, type Task, type WorkspaceMode } from "@openorc/protocol";
import { useProjectGit } from "../lib/project-git";
import { useRpc, useRpcMutation } from "../lib/query";
import { useUi } from "../lib/ui";
import { Select, TextButton } from "./ui";
import { taskExecutionDisabledReason } from "../lib/task-execution-availability";

export function ExecutionLocationSelect({
  value,
  onChange,
  disabled,
  worktreeBlocked,
}: {
  value: WorkspaceMode;
  onChange: (value: WorkspaceMode) => void;
  disabled?: boolean;
  /** The project can't have a worktree yet; a task already set to one can still leave it. */
  worktreeBlocked?: boolean;
}) {
  return (
    <label className="flex flex-wrap items-center gap-3 text-sm text-ink-3">
      Execution location
      <Select aria-label="Execution location" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as WorkspaceMode)}>
        <option value="current">Local checkout</option>
        <option value="worktree" disabled={worktreeBlocked}>
          Worktree
        </option>
      </Select>
    </label>
  );
}

/** Task preferences are independent of creation history; assigned conversations own existing work. */
export function useTaskExecutionLocation(task: Task, beforeChange: () => Promise<boolean>) {
  const owner = useRpc("tasks.executionThread", { taskId: task.id });
  const runs = useRpc("runs.listForTask", { taskId: task.id });
  const team = useRpc("orchestration.taskState", { taskId: task.id }, { enabled: Boolean(task.threadId) });
  const forwarding = useRpc("tasks.forwarding", { taskId: task.id });
  const save = useRpcMutation("tasks.update");
  const open = useRpcMutation("tasks.openThread");
  const move = useRpcMutation("threads.moveWorkspace");
  const [error, setError] = useState<string | null>(null);
  const [isPending, setPending] = useState(false);
  const pending = useRef<Promise<boolean> | null>(null);
  const targetHandoff = forwarding.data?.forwarding?.targetTaskId === task.id ? forwarding.data.forwarding : null;
  const ownWorkspace = Boolean(task.worktreePath || runs.data?.length || targetHandoff);
  const executionThread = owner.data ?? null;
  const sharedConversation = executionThread && (executionThread.id === task.threadId || executionThread.taskCount > 1);
  const pendingExecution = executionThread?.hasStarted === false && !executionThread.worktreePath && !ownWorkspace;
  const mode = executionThread?.workspaceMode ?? task.workspaceMode;
  const branch = executionThread ? executionThread.branch : task.branch;
  const loadError = runs.error || forwarding.error || (task.threadId ? team.error : null) || (!team.data?.ownerDeletedAt && owner.error);
  const loading = runs.isPending || forwarding.isPending || (!team.data?.ownerDeletedAt && owner.isPending) || Boolean(task.threadId && team.isPending);
  const activeLegacy = runs.data?.some((run) => run.state === "starting" || run.state === "running");
  const reason = taskExecutionDisabledReason({
    loadFailed: Boolean(loadError),
    loading,
    workspaceProject: task.projectId === WORKSPACE_ID,
    savedTeam: Boolean(team.data),
    sharedConversation: Boolean(sharedConversation),
    activeAgent: Boolean(activeLegacy),
    activeConversation: Boolean(executionThread && executionThread.activity !== "idle"),
    handoffPreparing: targetHandoff?.state === "preparing",
  });
  const refresh = () => {
    void runs.refetch();
    void forwarding.refetch();
    void owner.refetch();
    if (task.threadId) {
      void team.refetch();
    }
  };
  const change = (to: WorkspaceMode) => {
    if (pending.current || reason || to === mode) return;
    setPending(true);
    setError(null);
    const operation = (async () => {
      try {
        if (!(await beforeChange())) return false;
        if ((!executionThread && !ownWorkspace) || pendingExecution) await save.mutateAsync({ id: task.id, patch: { workspaceMode: to } });
        else {
          // The core resolves legacy task ownership. Never move its historical parent by guessing here.
          const thread = await open.mutateAsync({ taskId: task.id });
          const result = await move.mutateAsync({ id: thread.id, to });
          if ("rejected" in result) throw new Error(result.rejected);
        }
        return true;
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
        return false;
      } finally {
        pending.current = null;
        setPending(false);
        refresh();
      }
    })();
    pending.current = operation;
  };
  return {
    mode,
    branch,
    runs,
    team,
    reason,
    error,
    isPending,
    change,
    refresh,
    loadError,
    movesThread: Boolean((executionThread && !pendingExecution) || ownWorkspace),
    projectId: task.projectId,
    wait: () => pending.current ?? Promise.resolve(true),
    manageTeam: task.threadId && team.data && !team.data.ownerDeletedAt ? () => useUi.getState().setTeamMoveThread(task.threadId) : null,
  };
}

export function TaskExecutionSettings({ execution }: { execution: ReturnType<typeof useTaskExecutionLocation> }) {
  const { cannotBranch } = useProjectGit(execution.projectId);
  return (
    <details className="task-execution-settings" open>
      <summary className="text-sm text-ink-3 hover:text-ink select-none">Execution settings</summary>
      <div className="grid gap-3 mt-4">
        <ExecutionLocationSelect value={execution.mode} onChange={execution.change} disabled={execution.isPending || Boolean(execution.reason)} worktreeBlocked={cannotBranch} />
        <p className="text-sm text-ink-3">
          {execution.reason ??
            (execution.movesThread
              ? "Changing this location moves this task’s execution conversation and its uncommitted changes."
              : "This choice is saved for when work starts. Saving it does not start an agent or create a worktree.")}
        </p>
        {execution.manageTeam ? <TextButton onClick={execution.manageTeam}>Manage team workspace</TextButton> : null}
        {execution.loadError ? <TextButton onClick={execution.refresh}>Retry execution settings</TextButton> : null}
        {execution.isPending ? (
          <p role="status" className="text-sm text-ink-3">
            {execution.movesThread ? "Moving conversation…" : "Saving execution location…"}
          </p>
        ) : null}
        {execution.error ? (
          <p role="alert" className="text-sm text-bad">
            {execution.error} Choose the location again to retry.
          </p>
        ) : null}
      </div>
    </details>
  );
}
