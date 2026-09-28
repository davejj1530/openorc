import { useState, type ReactNode } from "react";
import type { Task, TaskForwarding as ForwardingRecord, WorkspaceMode } from "@openorc/protocol";
import { useRpc, useRpcMutation } from "../lib/query";
import { useTaskDraftActions } from "../lib/task-draft-context";
import { openTask } from "../lib/router";
import { Button, Select, TextButton } from "./ui";

function forwardButtonLabel(working: boolean, pending: boolean): string {
  if (working) return "Forwarding…";
  if (pending) return "Retry handoff";
  return "Forward to another agent";
}

function ForwardedTaskNotice({ record, destination }: { record: ForwardingRecord; destination: boolean }) {
  if (destination)
    return (
      <>
        <p>
          {record.state === "preparing" ? "Finish the saved handoff before starting this agent." : "Forwarded from a team. Choose a model below to continue independently."}{" "}
          <TextButton underline onClick={() => openTask(record.sourceTaskId, "chat")}>
            Open original task
          </TextButton>
        </p>
        <details>
          <summary className="cursor-pointer text-ink-3">Previous results</summary>
          <p className="mt-2 whitespace-pre-wrap break-words">{record.context}</p>
        </details>
      </>
    );
  return (
    <p>
      This task was forwarded; its team history is kept here.{" "}
      <TextButton underline onClick={() => openTask(record.targetTaskId, "chat")}>
        Open forwarded task
      </TextButton>
    </p>
  );
}

/** The old task remains a team record; the independent continuation gets the ordinary model picker. */
export function TaskForwarding({ task, team = false, children }: { task: Task; team?: boolean; children: ReactNode }) {
  const state = useRpc("tasks.forwarding", { taskId: task.id });
  const forward = useRpcMutation("tasks.forward");
  const drafts = useTaskDraftActions();
  const [location, setLocation] = useState<WorkspaceMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const record = state.data?.forwarding;
  const destination = record?.targetTaskId === task.id;
  const pending = record?.state === "preparing";
  const checkout = useRpc("review.checkoutState", { taskId: record?.targetTaskId ?? "" }, { enabled: pending && record?.workspaceMode === "current" });
  const mode = record?.workspaceMode ?? location ?? state.data?.workspaceMode ?? "current";
  const submit = async () => {
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      await drafts.flushTaskDraft(task.id);
      const next = await forward.mutateAsync({ taskId: task.id, workspaceMode: mode });
      openTask(next.id, "chat");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setWorking(false);
    }
  };
  const noticeBody: ReactNode =
    record && (destination || record.state === "ready") ? (
      <ForwardedTaskNotice record={record} destination={destination} />
    ) : (
      <>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={working || !state.data?.allowed || state.isError} onClick={() => void submit()}>
            {forwardButtonLabel(working, pending)}
          </Button>
          <Select aria-label="Forwarded task workspace" value={mode} disabled={working || Boolean(record)} onChange={(event) => setLocation(event.target.value as WorkspaceMode)}>
            <option value="current">Local checkout</option>
            <option value="worktree">Worktree</option>
          </Select>
        </div>
        <p className="text-ink-3">Open an independent task with its files and previous results, then choose an agent. This task stays as team history.</p>
        {state.data?.reason ? <p role="status">{state.data.reason}</p> : null}
        {state.isError ? (
          <p role="alert">
            Could not check handoff availability.{" "}
            <TextButton underline onClick={() => void state.refetch()}>
              Retry
            </TextButton>
          </p>
        ) : null}
      </>
    );
  const notice = (
    <section aria-label="Task handoff" className="shrink-0 max-h-64 overflow-y-auto px-6 py-3 text-sm text-ink-2 space-y-2">
      {noticeBody}
      {error || record?.error ? (
        <p role="alert" className="text-bad break-words">
          {error ?? record?.error}
        </p>
      ) : null}
      {pending && record.stagingPath ? (
        <div className="space-y-1">
          {checkout.data?.preview?.state === "conflict" ? (
            <>
              <p>Resolve the listed files in the retained worktree or local checkout, then retry the handoff.</p>
              <ul className="list-disc pl-4">
                {checkout.data.preview.conflicts.map((file) => (
                  <li key={file} className="break-all">
                    {file}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <TextButton underline onClick={() => window.openorc.revealFile(record.stagingPath!)}>
            Reveal retained worktree
          </TextButton>
          <p className="text-xs text-ink-3 break-all">{record.stagingPath}</p>
        </div>
      ) : null}
    </section>
  );
  return (
    <div className="h-full min-h-0 flex flex-col">
      {team || record ? notice : null}
      <div className="flex-1 min-h-0">{destination && pending ? null : children}</div>
    </div>
  );
}
