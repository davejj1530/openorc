import { useEffect, useRef, useState } from "react";
import { normalizeModelSettings, type AgentKind, type PermissionPreset, type Run, type RunMode, type ThreadSummary } from "@openorc/protocol";
import { defaultChoice, type ModelChoice } from "../components/ModelPicker";
import { useRpc, useRpcMutation } from "./query";
import { usePermissionSelection } from "./permission-default";

type SavedThreadSettings = Pick<ThreadSummary, "id" | "agent" | "model" | "effort" | "fastMode" | "mode" | "permissionMode">;

function savedModelChoice(thread: SavedThreadSettings | null, activeRun: Run | undefined): ModelChoice | null {
  if (thread?.model) return normalizeModelSettings({ agent: thread.agent, model: thread.model, effort: thread.effort, fastMode: thread.fastMode });
  if (activeRun?.model) return normalizeModelSettings({ agent: activeRun.agent, model: activeRun.model, effort: activeRun.effort, fastMode: activeRun.fastMode });
  return null;
}

/** Model/policy choices persist in selection order, before any message is sent. */
export function useConversationSettings({ thread, activeRun }: { thread: SavedThreadSettings | null; activeRun: Run | undefined }) {
  const models = useRpc("agents.models", {}, { staleTime: 5 * 60_000 });
  const updateThread = useRpcMutation("threads.update");
  const stored = savedModelChoice(thread, activeRun);
  const [choice, setChoice] = useState<ModelChoice | null>(stored);
  const storedKey = JSON.stringify(stored);
  const previousStored = useRef(storedKey);
  useEffect(() => {
    // Slack and other windows can change the authoritative thread settings while this view stays mounted.
    if (previousStored.current !== storedKey) {
      previousStored.current = storedKey;
      setChoice(stored);
    }
  }, [storedKey, stored]);
  useEffect(() => {
    if (!models.data) return;
    const prefer = thread ? thread.agent : (activeRun?.agent ?? null);
    // Keep saved execution settings visible even while the catalog is stale or unavailable.
    if (!choice) setChoice(stored ?? defaultChoice(models.data, prefer));
  }, [choice, models.data, stored, thread, activeRun?.agent]);
  const [mode, setMode] = useState<RunMode>(thread ? thread.mode : (activeRun?.mode ?? "act"));
  const savedMode = thread?.mode ?? activeRun?.mode;
  const lastSavedMode = useRef(savedMode);
  useEffect(() => {
    if (savedMode && savedMode !== lastSavedMode.current) {
      lastSavedMode.current = savedMode;
      setMode(savedMode);
    }
  }, [savedMode]);
  const { permission, select: setPermission, error: permissionError, ready: permissionReady } = usePermissionSelection(thread?.permissionMode ?? activeRun?.permissionMode);
  // Autonomous also updates approvals on the running turn; other settings persist for resume.
  const settingsSave = useRef<Promise<unknown>>(Promise.resolve());
  const persist = (patch: { mode?: RunMode; permissionMode?: PermissionPreset; agent?: AgentKind; model?: string; effort?: string | null; fastMode?: boolean }) => {
    if (!thread) return;
    // Preserve selection order and finish saving before a message can drain from the queue.
    settingsSave.current = settingsSave.current
      .catch(() => {
        /* The mutation owns error presentation; a later selection can retry. */
      })
      .then(() => updateThread.mutateAsync({ id: thread.id, patch }));
    void settingsSave.current.catch(() => {
      /* The mutation owns error presentation; a later selection can retry. */
    });
  };

  const selectModel = (next: ModelChoice) => {
    setChoice(next);
    persist({ ...next, fastMode: Boolean(next.fastMode) });
  };
  const selectMode = (next: RunMode) => {
    setMode(next);
    persist({ mode: next });
  };
  const selectPermission = (next: PermissionPreset) => {
    setPermission(next);
    persist({ permissionMode: next });
  };
  const selectExecutionMode = (next: { mode: RunMode; permissionMode: PermissionPreset }) => {
    setMode(next.mode);
    setPermission(next.permissionMode);
    persist(next);
  };
  return {
    choice,
    mode,
    permission,
    permissionReady,
    permissionError,
    error: updateThread.error,
    selectModel,
    selectMode,
    selectPermission,
    selectExecutionMode,
    waitForSave: () => settingsSave.current,
  };
}
