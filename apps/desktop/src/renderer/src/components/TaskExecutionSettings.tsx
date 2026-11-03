import { WORKSPACE_ID, type Task, type WorkspaceMode } from "@openorc/protocol";
import { useRef, useState } from "react";
import { useRpc, useRpcMutation } from "../lib/client";
import { useProjectGit } from "../lib/project-git";
import { taskExecutionDisabledReason } from "../lib/task-execution-availability";
import { Select, TextButton } from "./ui";

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
  const save = useRpcMutation("tasks.update");
  const open = useRpcMutation("tasks.openThread");
  const move = useRpcMutation("threads.moveWorkspace");
  const [error, setError] = useState<string | null>(null);
  const [isPending, setPending] = useState(false);
  const pending = useRef<Promise<boolean> | null>(null);
  const ownWorkspace = Boolean(task.worktreePath || runs.data?.length);
  const executionThread = owner.data ?? null;
  const sharedConversation = executionThread && (executionThread.id === task.threadId || executionThread.taskCount > 1);
  const pendingExecution = executionThread?.hasStarted === false && !executionThread.worktreePath && !ownWorkspace;
  const mode = executionThread?.workspaceMode ?? task.workspaceMode;
  const branch = executionThread ? executionThread.branch : task.branch;
  const loadError = runs.error || owner.error;
  const loading = runs.isPending || owner.isPending;
  const activeLegacy = runs.data?.some((run) => run.state === "starting" || run.state === "running");
  const reason = taskExecutionDisabledReason({
    loadFailed: Boolean(loadError),
    loading,
    workspaceProject: task.projectId === WORKSPACE_ID,
    savedTeam: Boolean(task.retiredTeam),
    sharedConversation: Boolean(sharedConversation),
    activeAgent: Boolean(activeLegacy),
    activeConversation: Boolean(executionThread && executionThread.activity !== "idle"),
  });
  const refresh = () => {
    void runs.refetch();
    void owner.refetch();
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
          await move.mutateAsync({ id: thread.id, to });
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
    reason,
    error,
    isPending,
    change,
    refresh,
    loadError,
    movesThread: Boolean((executionThread && !pendingExecution) || ownWorkspace),
    projectId: task.projectId,
    wait: () => pending.current ?? Promise.resolve(true),
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
