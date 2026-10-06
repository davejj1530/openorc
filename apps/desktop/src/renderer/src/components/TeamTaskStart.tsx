import { teamTaskSubmitLabel } from "../lib/team-action-presentation";
import { useEffect, useRef, useState } from "react";
import type { TeamTaskAdmissionView, TeamTaskView } from "@openorc/protocol";
import { Button, TextButton } from "./ui";
import { Play } from "./icons";
import { permissionLabel } from "./Composer";
import { queryClient, useRpcMutation } from "../lib/query";
import { openTask, openThread } from "../lib/router";
import { useTaskDraftActions } from "../lib/task-draft-context";
import { beginTeamTaskRequest, finishTeamTaskRequest, readTeamTaskRequest, teamTaskAdmissionLabel, type TeamTaskRequest, type TeamTaskRequestScope } from "../lib/team-task-actions";

export function useTeamTaskRequest(scope: TeamTaskRequestScope) {
  const { flushTaskDraft } = useTaskDraftActions();
  const start = useRpcMutation("orchestration.tasks.start");
  const review = useRpcMutation("orchestration.review.send");
  const retry = useRpcMutation("orchestration.tasks.retry");
  const [pending, setPending] = useState<TeamTaskRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const inFlight = useRef(false);
  const scopeKey = JSON.stringify(scope);
  useEffect(() => {
    const restore = () => {
      try {
        setPending(readTeamTaskRequest(scope));
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    };
    restore();
    window.addEventListener("storage", restore);
    window.addEventListener("openorc:team-task-request", restore);
    return () => {
      window.removeEventListener("storage", restore);
      window.removeEventListener("openorc:team-task-request", restore);
    };
  }, [scopeKey]);
  const submit = async (commentIds: string[] = []) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setWorking(true);
    setError(null);
    try {
      let request = readTeamTaskRequest(scope);
      if (!request) {
        if (scope.kind !== "retry") await flushTaskDraft(scope.taskId);
        request = beginTeamTaskRequest(scope, commentIds);
      }
      setPending(request);
      let result: Awaited<ReturnType<typeof start.mutateAsync>>;
      if (request.kind === "start") result = await start.mutateAsync({ taskId: request.taskId, requestKey: request.requestKey });
      else if (request.kind === "review") result = await review.mutateAsync({ taskId: request.taskId, requestKey: request.requestKey, commentIds: request.commentIds });
      else result = await retry.mutateAsync({ taskId: request.taskId, requestKey: request.requestKey, admissionId: request.admissionId });
      queryClient.setQueryData<TeamTaskView | null>(["orchestration.taskState", { taskId: request.taskId }], (previous) =>
        previous?.admissions.some((item) => item.id === result.admissionId) ? previous : result.task,
      );
      finishTeamTaskRequest(request);
      setPending(readTeamTaskRequest(scope));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      inFlight.current = false;
      setWorking(false);
    }
  };
  return { pending, error, working, submit };
}

export function TeamTaskIdentity({ task }: { task: TeamTaskView }) {
  const assigned = task.admissions.findLast((item) => item.role === "assignee");
  const member = task.members.find((item) => item.key === (assigned?.memberKey ?? task.memberKey));
  const manager = task.members.find((item) => item.key === task.managerKey);
  const policy = task.policy;
  return (
    <div className="text-sm text-ink-3 break-words space-y-1">
      <p>
        {member
          ? `${member.name} · ${member.settings.model}${member.settings.effort ? ` · ${member.settings.effort}` : ""}${member.settings.fastMode ? " · Fast" : ""}`
          : `${manager?.name ?? "Lead"} will assign this task`}{" "}
        · {task.teamName}
      </p>
      <p>
        {permissionLabel[policy.requested]}
        {taskPermissionExplanation(policy)}
      </p>
    </div>
  );
}

/** Inside the retained team view the link would only reopen the current screen. */
export function TeamTaskStart({ task, inline = false }: { task: TeamTaskView; inline?: boolean }) {
  const request = useTeamTaskRequest({ taskId: task.taskId, kind: "start" });
  return (
    <section className="space-y-2" aria-label="Team task execution">
      <TeamTaskIdentity task={task} />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={request.working || (!request.pending && !task.start.allowed)}
          title={request.pending ? undefined : (task.start.reason ?? undefined)}
          onClick={() => void request.submit()}
        >
          <Play size={12} />
          {teamTaskSubmitLabel({ working: request.working, pending: Boolean(request.pending), kind: "start" })}
        </Button>
        {!inline && task.ownerDeletedAt ? (
          <Button size="sm" variant="ghost" onClick={() => openTask(task.taskId, "chat")}>
            Open team activity
          </Button>
        ) : null}
        {!inline && !task.ownerDeletedAt ? (
          <Button size="sm" variant="ghost" onClick={() => openThread(task.threadId)}>
            Open team conversation
          </Button>
        ) : null}
      </div>
      {!task.start.allowed && !request.pending && task.start.reason ? <p className="text-sm text-ink-3">{task.start.reason}</p> : null}
      {request.pending ? <p className="text-xs text-ink-3">The saved request will be confirmed before another is created.</p> : null}
      {request.error ? (
        <p role="alert" className="text-sm text-bad break-words">
          {request.error}{" "}
          <TextButton underline onClick={() => openTask(task.taskId, "spec")}>
            Open Overview
          </TextButton>
        </p>
      ) : null}
    </section>
  );
}

function TeamTaskRetry({ task, admission }: { task: TeamTaskView; admission: TeamTaskAdmissionView }) {
  const request = useTeamTaskRequest({ taskId: task.taskId, kind: "retry", admissionId: admission.id });
  if (!admission.retry.allowed && !request.pending && !request.error) return null;
  return (
    <div className="mt-2 space-y-1">
      <Button size="sm" disabled={request.working || (!request.pending && !admission.retry.allowed)} title={admission.retry.reason ?? undefined} onClick={() => void request.submit()}>
        {teamTaskSubmitLabel({ working: request.working, pending: Boolean(request.pending), kind: admission.kind === "review" ? "review" : "retry" })}
      </Button>
      {request.error ? (
        <p role="alert" className="text-sm text-bad break-words">
          {request.error}
        </p>
      ) : null}
    </div>
  );
}

export function TeamTaskAdmissions({ task, kind }: { task: TeamTaskView; kind?: "start" | "review" }) {
  const admissions = task.admissions.filter((item) => !kind || item.kind === kind);
  if (!admissions.length) return null;
  return (
    <div className="space-y-3" aria-label="Task request history">
      {admissions.map((admission) => (
        <div key={admission.id} data-team-admission={admission.id} data-admission-state={admission.state} className="text-sm break-words">
          <p className="text-ink-2">
            {admission.kind === "review" ? `Review · ${admission.reviewBatch?.comments.length ?? 0} comment${admission.reviewBatch?.comments.length === 1 ? "" : "s"}` : "Task request"}{" "}
            <span className="text-ink-3">· {teamTaskAdmissionLabel(admission, task.members)}</span>
          </p>
          {admission.error ? <p className="text-bad mt-1">{admission.error}</p> : null}
          {admission.result ? (
            <details className="mt-1 text-ink-2">
              <summary className="text-ink-3">Result</summary>
              <p className="mt-2 whitespace-pre-wrap">{admission.result}</p>
            </details>
          ) : null}
          <TeamTaskRetry key={admission.id} task={task} admission={admission} />
        </div>
      ))}
    </div>
  );
}

function taskPermissionExplanation(policy: TeamTaskView["policy"]): string {
  if (policy.pendingRestart) return ` requested. Current agents: ${policy.effective ? permissionLabel[policy.effective] : "mixed permissions"}; changes apply after they finish.`;
  if (policy.effective && policy.effective !== policy.requested) return ` selected. Current agents: ${permissionLabel[policy.effective]}.`;
  return "";
}
