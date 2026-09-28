import { useEffect, useRef, useState } from "react";
import { useRpc, useRpcMutation } from "./query";
import { openThread, useRouter } from "./router";
import { beginTeamForkRequest, finishTeamForkRequest, readTeamForkRequest, teamForkRequestChanged, teamForkStorageKey, type TeamForkRequest } from "./team-fork-request";
import { useThreadMutationPending } from "./thread-mutations";

/** All team fork entry points share one durable request and its exact cutoff. */
export function useTeamFork(threadId: string, enabled = true, sourceTaskId?: string) {
  const runtime = useRpc("orchestration.runtime", { threadId }, { enabled });
  const mutation = useRpcMutation("threads.fork");
  const mutating = useThreadMutationPending(threadId);
  const inFlight = useRef(false);
  const currentThread = useRef(threadId);
  currentThread.current = threadId;
  const read = (): { request: TeamForkRequest | null; error: string | null } => {
    if (!enabled) return { request: null, error: null };
    try {
      return { request: readTeamForkRequest(threadId), error: null };
    } catch (error) {
      return { request: null, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const [saved, setSaved] = useState(read);
  const [failure, setFailure] = useState<{ message: string; upToRunId: string | null } | null>(null);
  const recovery = runtime.data?.actions?.forkRecovery;
  const pending = recovery ?? saved.request;
  useEffect(() => {
    setSaved(read());
    setFailure(null);
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key === teamForkStorageKey(threadId)) setSaved(read());
    };
    const local = (event: Event) => {
      if ((event as CustomEvent<string>).detail === threadId) setSaved(read());
    };
    window.addEventListener("storage", storage);
    window.addEventListener(teamForkRequestChanged, local);
    return () => {
      window.removeEventListener("storage", storage);
      window.removeEventListener(teamForkRequestChanged, local);
    };
  }, [threadId, enabled]);
  let reason: string | null = null;
  if (enabled) {
    if (runtime.isError) reason = "Could not check team fork availability. Refresh team status to retry.";
    else if (runtime.isPending || !runtime.data) reason = "Checking team fork availability…";
    else if (!runtime.data.actions?.fork) reason = "Team fork availability is missing. Refresh team status to retry.";
    else if (!recovery && saved.error) reason = saved.error;
    else if (!pending && !runtime.data.actions.fork.allowed) reason = runtime.data.actions.fork.reason ?? "Fork is currently unavailable for this team.";
  }
  const reasonFor = (upToRunId?: string | null) =>
    reason ?? (pending && upToRunId !== undefined && pending.upToRunId !== upToRunId ? "A fork from another point needs confirmation first. Use Retry fork in the task menu." : null);
  const refresh = () => {
    setSaved(read());
    void runtime.refetch();
  };
  const run = async (upToRunId?: string | null) => {
    if (!enabled || reasonFor(upToRunId) || mutating || inFlight.current) return;
    inFlight.current = true;
    setFailure(null);
    const route = useRouter.getState().route;
    const viewingSource = (route.view === "thread" && route.threadId === threadId) || (route.view === "task" && route.taskId === sourceTaskId);
    let cutoff = upToRunId ?? pending?.upToRunId ?? null;
    try {
      const request = beginTeamForkRequest(threadId, { ...(recovery ? { recovery } : {}), ...(upToRunId !== undefined ? { upToRunId } : {}) });
      cutoff = request.upToRunId;
      setSaved({ request, error: null });
      const result = await mutation.mutateAsync({ id: threadId, requestKey: request.requestKey, ...(request.upToRunId ? { upToRunId: request.upToRunId } : {}) });
      if ("rejected" in result) {
        const message = result.rejected || "This fork request was rejected. Choose another reply or fork the current workspace.";
        const cleared = finishTeamForkRequest(threadId, request);
        if (currentThread.current === threadId) {
          setSaved(read());
          setFailure({
            upToRunId: cutoff,
            message: cleared ? message : `${message} The rejection is confirmed, but its local recovery record could not be cleared. Retry fork when local storage is available.`,
          });
        }
        return;
      }
      if (!finishTeamForkRequest(threadId, request)) throw new Error("The fork was created, but its local recovery record could not be cleared. Retry fork to confirm the same task.");
      if (currentThread.current === threadId) setSaved(read());
      if (viewingSource && useRouter.getState().route === route) openThread(result.id);
    } catch (error) {
      if (currentThread.current === threadId) setFailure({ upToRunId: cutoff, message: error instanceof Error ? error.message : String(error) });
    } finally {
      inFlight.current = false;
      void runtime.refetch();
    }
  };
  return {
    pending,
    failure,
    reason,
    reasonFor,
    run,
    refresh,
    working: mutation.isPending,
    mutating,
    recoveryError: recovery?.error ?? null,
    refreshing: runtime.isFetching,
    needsRefresh: enabled && (runtime.isError || !runtime.data?.actions?.fork || Boolean(saved.error)),
  };
}

export type TeamForkControls = ReturnType<typeof useTeamFork>;
