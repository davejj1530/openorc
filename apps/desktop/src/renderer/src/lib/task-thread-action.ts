import { useRef, useState } from "react";
import { isHostedAgent, type OnlineTask, type OnlineTaskRef, type OnlineTaskThreadSettings } from "@openorc/protocol";
import { usePermissionSelection, useRpc } from "./client";
import { useDefaultHarness } from "./default-harness";
import { initialThreadChoice } from "./new-thread-availability";
import { useHostedFileScope } from "./hosted-file-scope";
import { organizationContentGate } from "./organization-content-gate";
import { useTaskOnlineMutation, useTaskOnlineScope } from "./task-online-query";
import { stageStoredTask } from "./task-thread-storage";
import { TaskThreadOpener } from "./task-thread-open";
import { taskThreadDestination } from "./task-thread-destination";

export interface TaskThreadAction {
  reference: OnlineTaskRef;
  task: OnlineTask;
  beforeOpen?(): Promise<boolean>;
  getTask?(): OnlineTask;
  onConflict?(task: OnlineTask): void;
}
export function useTaskThreadAction({ reference, task, beforeOpen, getTask, onConflict }: TaskThreadAction) {
  const { scope: current, availability } = useTaskOnlineScope();
  const scope = useHostedFileScope({ projectId: reference.projectId, enabled: Boolean(availability?.execution) });
  const mutation = useTaskOnlineMutation(reference, "tasks.online.openThread");
  const settings = useCloudThreadSettings();
  const write = useRef(mutation.mutateAsync);
  write.current = mutation.mutateAsync;
  const [opener] = useState(() => new TaskThreadOpener(reference, (input) => write.current(input)));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const reason = taskThreadReason(task, availability?.execution === true, Boolean(scope && current?.accountId === reference.accountId && current.spaceId === reference.spaceId));
  const open = async () => {
    if (reason || !scope || busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    const ticket = organizationContentGate.capture(reference.spaceId, reference.accountId);
    const destination = taskThreadDestination(scope);
    try {
      const result = await opener.open({ scope, settings, task: getTask ?? (() => task), flush: beforeOpen ?? (async () => true), current: ticket.current, stage: stageStoredTask, ...destination });
      if (result?.state === "conflict") {
        onConflict?.(result.task);
        setError("This task changed. Review it before opening its thread.");
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  return { open, reason, pending, error };
}

/**
 * What a new cloud thread's composer starts with, so a task's new thread names the person's agent and runs with their
 * own permission from the start, as their other cloud threads do.
 */
export function useCloudThreadSettings(): OnlineTaskThreadSettings | null {
  const models = useRpc("agents.models", {}, { staleTime: 5 * 60_000 });
  const info = useRpc("system.info", {});
  const preferred = useDefaultHarness();
  const { permission, ready } = usePermissionSelection();
  if (!models.data || preferred === undefined || !ready) return null;
  const choice = initialThreadChoice(models.data, preferred, info.data, true);
  return choice && isHostedAgent(choice.agent) ? { agent: choice.agent, model: choice.model, effort: choice.effort ?? null, mode: "act", permissionMode: permission } : null;
}

function taskThreadReason(task: OnlineTask, execution: boolean, available: boolean): string | null {
  if (task.execution.state === "unavailable") return "This task’s thread is unavailable.";
  if (!execution) return "Opening cloud task threads isn’t available yet.";
  if (!available) return "This task isn’t available here.";
  if (!navigator.onLine) return "Connect to the internet to open this thread.";
  return task.viewer.mayOpenThread ? null : "You can’t open this task’s thread.";
}
