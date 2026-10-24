import { newThreadChoice, newThreadStartInput, newThreadWorkspaceMode, targetModel } from "@openorc/client";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { useRpc, useRpcMutation } from "../client";
import { composerControls } from "../composer/composer-state";
import type { ComposerSettings } from "../composer/settings-bridge";
import { useImageAttach } from "../composer/use-image-attach";
import { failureMessage } from "../failure";
import { useSheetDraft, useSheetPermission } from "./drafts";
import { afterStart, startBlocker, type SheetDraft } from "./new-thread-state";

/**
 * A new thread in one project, with the desktop's defaults: the catalog's default model (a phone cannot see which
 * harnesses are signed in), mode act, the Mac's default permission until one is chosen here, and the Mac's default
 * workspace where the project can branch. `canBranch` is undefined until the Mac's projects load. The phone never names
 * a folder: Workspace runs where the Mac's Workspace does. A start the Mac refuses keeps the draft and says why.
 */
export function useNewThread(projectId: string, canBranch: boolean | undefined) {
  const [draft, setDraft] = useSheetDraft(projectId);
  const permission = useSheetPermission();
  const models = useRpc("agents.models", {}, { staleTime: 5 * 60_000 });
  const appSettings = useRpc("app.settings.get", {});
  const start = useRpcMutation("threads.start");
  // A second tap can land before the first start renders, so the start in flight is held here as well.
  const starting = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const change = (patch: Partial<SheetDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  };
  const { uploading, chooseImages } = useImageAttach({ onImage: (image) => setDraft((current) => ({ ...current, images: [...current.images, image] })), onError: setError });

  // The desktop's first choice, made once the catalog is in and kept with the draft.
  useEffect(() => {
    if (draft.target.kind !== "model" || draft.target.choice || !models.data) return;
    const choice = newThreadChoice(models.data, null);
    if (choice) setDraft((current) => ({ ...current, target: { kind: "model", choice } }));
  }, [draft.target, models.data, setDraft]);

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
    sending: start.isPending,
    disabledReason: startBlocker(draft, { projectReady: canBranch !== undefined, permissionReady: permission.ready }),
    working: false,
    steerable: false,
    stoppable: false,
    stopping: false,
  });

  /** Starts the thread and resolves with its id, or with null when nothing could go or the Mac refused. */
  const submit = async (): Promise<string | null> => {
    if (!controls.canSend || starting.current) return null;
    starting.current = true;
    const sent = { prompt: draft.prompt.trim(), attachments: draft.images.map((image) => image.path) };
    const workspaceMode = newThreadWorkspaceMode({ canBranch: Boolean(canBranch), chosen: draft.workspace, preferred: appSettings.data?.defaultWorkspaceMode });
    setError(null);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const { thread } = await start.mutateAsync(newThreadStartInput(draft, { workspaceMode, permissionMode: permission.permission, ...sent }));
      setDraft((current) => afterStart(current, sent));
      return thread.id;
    } catch (failure) {
      setError(failureMessage(failure));
      return null;
    } finally {
      starting.current = false;
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
    starting: start.isPending,
    error,
    submit,
  };
}
