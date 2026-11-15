import { useEffect, useRef, useState } from "react";
import { normalizeModelSettings, type AgentKind, type PermissionPreset, type Run, type RunMode, type ThreadSummary } from "@openorc/protocol";
import { defaultChoice, type ModelChoice } from "./model-picker-selection.js";
import type { PermissionDefault } from "./permission-default.js";
import type { ClientQueries } from "./query.js";

export type SavedThreadSettings = Pick<ThreadSummary, "id" | "agent" | "model" | "effort" | "fastMode" | "mode" | "permissionMode">;

type SettingsPatch = { mode?: RunMode; permissionMode?: PermissionPreset; agent?: AgentKind; model?: string; effort?: string | null; fastMode?: boolean };

/** The settings the composer picks one at a time; a model always saves with its agent, effort and speed. */
type Setting = "model" | "mode" | "permission";
const settingFields: Record<Setting, (keyof SettingsPatch)[]> = { model: ["agent", "model", "effort", "fastMode"], mode: ["mode"], permission: ["permissionMode"] };
const settingsIn = (patch: SettingsPatch) => (Object.keys(settingFields) as Setting[]).filter((setting) => settingFields[setting].some((field) => field in patch));

function savedModelChoice(thread: SavedThreadSettings | null, activeRun: Run | undefined): ModelChoice | null {
  if (thread?.model) return normalizeModelSettings({ agent: thread.agent, model: thread.model, effort: thread.effort, fastMode: thread.fastMode });
  if (activeRun?.model) return normalizeModelSettings({ agent: activeRun.agent, model: activeRun.model, effort: activeRun.effort, fastMode: activeRun.fastMode });
  return null;
}

/** Model/policy choices persist in selection order, before any message is sent. */
export function useConversationSettingsWith(queries: ClientQueries, permissions: PermissionDefault, { thread, activeRun }: { thread: SavedThreadSettings | null; activeRun: Run | undefined }) {
  const models = queries.useRpc("agents.models", {}, { staleTime: 5 * 60_000 });
  const updateThread = queries.useRpcMutation("threads.update");
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
  const { permission, select: setPermission, error: permissionError, ready: permissionReady } = permissions.usePermissionSelection(thread?.permissionMode ?? activeRun?.permissionMode);
  // Autonomous also updates approvals on the running turn; other settings persist for resume.
  const settingsSave = useRef<Promise<unknown>>(Promise.resolve());
  // Settings whose save failed. A queued message runs with what the Mac saved, so a send first saves what the composer
  // shows for them: the failed pick, or the thread's own value if another window changed it since.
  const unsaved = useRef(new Set<Setting>());
  const write = (threadId: string, patch: SettingsPatch) =>
    updateThread.mutateAsync({ id: threadId, patch }).then(
      () => settingsIn(patch).forEach((setting) => unsaved.current.delete(setting)),
      (error: unknown) => {
        settingsIn(patch).forEach((setting) => unsaved.current.add(setting));
        throw error;
      },
    );
  // Saves run one at a time in selection order, and a message waits for them before it can drain from the queue.
  const enqueue = (step: () => Promise<void> | undefined) => {
    settingsSave.current = settingsSave.current
      .catch(() => {
        /* The mutation owns error presentation; the next send saves the fields again. */
      })
      .then(step);
    return settingsSave.current;
  };
  const persist = (patch: SettingsPatch) => {
    if (!thread) return;
    void enqueue(() => write(thread.id, patch)).catch(() => {
      /* The mutation owns error presentation; the next send saves the fields again. */
    });
  };
  const shown: Record<Setting, SettingsPatch> = { model: choice ? { ...choice, fastMode: Boolean(choice.fastMode) } : {}, mode: { mode }, permission: { permissionMode: permission } };
  const waitForSave = () =>
    enqueue(() => {
      const patch: SettingsPatch = Object.assign({}, ...[...unsaved.current].map((setting) => shown[setting]));
      return thread && Object.keys(patch).length ? write(thread.id, patch) : undefined;
    });

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
    waitForSave,
  };
}
