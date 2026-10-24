import { newThreadChoice, newThreadStartInput, newThreadWorkspaceMode, projectGitView, targetModel } from "@openorc/client";
import { WORKSPACE_ID } from "@openorc/protocol";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { link, useRpc, useRpcMutation } from "../client";
import { composerControls } from "../composer/composer-state";
import type { ComposerSettings } from "../composer/settings-bridge";
import { useImageAttach } from "../composer/use-image-attach";
import { failureMessage } from "../failure";
import { useSheetDraft, useSheetPermission } from "./drafts";
import { afterStart, startBlocker, type SheetDraft } from "./new-thread-state";

/**
 * A new thread in one project, with the desktop's defaults: the model for the Mac's default harness or its first
 * signed-in one, mode act, the Mac's default permission until one is chosen here, and the Mac's default workspace
 * where the project can branch. The phone never names a folder: Workspace runs where the Mac's Workspace does. A start
 * the Mac refuses keeps the draft and says why.
 */
export function useNewThread(projectId: string) {
  const isWorkspace = projectId === WORKSPACE_ID;
  const [draft, setDraft] = useSheetDraft(projectId);
  const permission = useSheetPermission();
  const models = useRpc("agents.models", {}, { staleTime: 5 * 60_000 });
  const harnesses = useRpc("agents.availability", {});
  const appSettings = useRpc("app.settings.get", {});
  const start = useRpcMutation("threads.start");
  // From the tap until the Mac answers, which includes reading the project's git first.
  const [starting, setStarting] = useState(false);
  // A second tap can land before the first start renders, so the start in flight is held here as well.
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const change = (patch: Partial<SheetDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  };
  const { uploading, chooseImages } = useImageAttach({ onImage: (image) => setDraft((current) => ({ ...current, images: [...current.images, image] })), onError: setError });

  // The desktop's first choice, made from the same reads once they are in and kept with the draft.
  useEffect(() => {
    if (draft.target.kind !== "model" || draft.target.choice || !models.data || !harnesses.data || !appSettings.data) return;
    const choice = newThreadChoice(models.data, { preferred: appSettings.data.defaultHarness, harnesses: harnesses.data });
    if (choice) setDraft((current) => ({ ...current, target: { kind: "model", choice } }));
  }, [draft.target, models.data, harnesses.data, appSettings.data, setDraft]);

  const settings: ComposerSettings = {
    choice: targetModel(draft.target),
    mode: draft.mode,
    permission: permission.permission,
    selectModel: (choice) => change({ target: { kind: "model", choice } }),
    selectExecutionMode: (next) => {
      change({ mode: next.mode });
      permission.select(next.permissionMode);
    },
  };
  const controls = composerControls({
    text: draft.prompt,
    attachments: draft.images.length,
    uploading,
    sending: starting,
    disabledReason: startBlocker(draft, { permissionReady: permission.ready }),
    working: false,
    steerable: false,
    stoppable: false,
    stopping: false,
  });

  /**
   * Whether a worktree can branch here, as the desktop's New thread decides it. The phone shows no workspace, so it asks
   * the Mac's git at every Start: a first commit made since the last read, or a repository removed since, counts.
   */
  const canBranch = async () => !isWorkspace && !projectGitView(await link.connection.call("projects.git", { id: projectId })).cannotBranch;

  /** Starts the thread and resolves with its id, or with null when nothing could go or the Mac refused. */
  const submit = async (): Promise<string | null> => {
    if (!controls.canSend || inFlight.current) return null;
    inFlight.current = true;
    setStarting(true);
    const sent = { prompt: draft.prompt.trim(), attachments: draft.images.map((image) => image.path) };
    setError(null);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const workspaceMode = newThreadWorkspaceMode({ canBranch: await canBranch(), chosen: draft.workspace, preferred: appSettings.data?.defaultWorkspaceMode });
      const { thread } = await start.mutateAsync(newThreadStartInput(draft, { workspaceMode, permissionMode: permission.permission, ...sent }));
      setDraft((current) => afterStart(current, sent));
      return thread.id;
    } catch (failure) {
      setError(failureMessage(failure));
      return null;
    } finally {
      inFlight.current = false;
      setStarting(false);
    }
  };

  return {
    draft,
    setText: (prompt: string) => change({ prompt }),
    removeImage: (path: string) => setDraft((current) => ({ ...current, images: current.images.filter((image) => image.path !== path) })),
    uploading,
    chooseImages,
    settings,
    controls,
    starting,
    error,
    submit,
  };
}
