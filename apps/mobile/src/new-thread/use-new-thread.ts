import { newThreadChoice, newThreadStartInput, newThreadWorkspaceMode, projectGitView, runsInCloud, targetModel } from "@openorc/client";
import { WORKSPACE_ID } from "@openorc/protocol";
import { useContext, useEffect, useRef, useState } from "react";
import { hostLink, useRpc, useRpcMutation } from "../client";
import { HostContext } from "../connection/host-context";
import { composerControls } from "../composer/composer-state";
import { useDimReason } from "../composer/dim-reason";
import type { ComposerSettings } from "../composer/settings-bridge";
import { useEmptiedPrompt } from "../composer/keyboard-leftover";
import { useImageAttach } from "../composer/use-image-attach";
import { failureMessage } from "../failure";
import { unfoldProject } from "../home/folds";
import { haptic } from "../ui/haptics";
import { useSheetDraft, useSheetPermission } from "./drafts";
import { startBlocker, unstarted, type SheetDraft } from "./new-thread-state";

/**
 * A new thread in one project, with the desktop's defaults: the model for the Mac's default harness or its first
 * signed-in one, mode act, the Mac's default permission and Claude account until one is chosen here, and the Mac's
 * default workspace where the project can branch, or a cloud sandbox when chosen. The phone never names a folder:
 * Workspace runs where the Mac's Workspace does. A start the Mac refuses keeps the draft and says why.
 */
export function useNewThread(projectId: string) {
  const [draft, setDraft] = useSheetDraft(projectId);
  const permission = useSheetPermission();
  const appSettings = useDefaultChoice(draft, setDraft);
  const start = useRpcMutation("threads.start");
  // From the tap until the Mac answers, which includes reading the project's git first.
  const [starting, setStarting] = useState(false);
  // A second tap can land before the first start renders, so the start in flight is held here as well.
  const inFlight = useRef(false);
  const field = useEmptiedPrompt();
  // A failure belongs to the project it happened in; switching projects leaves it behind.
  const [failure, setFailure] = useState<{ projectId: string; message: string } | null>(null);
  const setError = (message: string | null) => setFailure(message === null ? null : { projectId, message });
  const change = (patch: Partial<SheetDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  };
  const { uploading, chooseImages } = useImageAttach({ onImage: (image) => setDraft((current) => ({ ...current, images: [...current.images, image] })), onError: setError });

  const cloud = useCloudPlace(projectId, draft, change);
  const host = useContext(HostContext);
  const settings: ComposerSettings = {
    choice: targetModel(draft.target),
    mode: draft.mode,
    permission: permission.permission,
    selectModel: (choice) => change({ target: { kind: "model", choice } }),
    selectExecutionMode: (next) => {
      change({ mode: next.mode });
      permission.select(next.permissionMode);
    },
    claudeAccount: { chosen: draft.claudeAccountId, select: (claudeAccountId) => change({ claudeAccountId }) },
    ...cloud,
  };
  const blocker = startBlocker(draft, { permissionReady: permission.ready });
  const controls = composerControls({
    text: draft.prompt,
    attachments: draft.images.length,
    uploading,
    sending: starting,
    disabledReason: blocker,
    working: false,
    steerable: false,
    stoppable: false,
    stopping: false,
  });
  const dim = useDimReason(controls.canSend ? null : blocker);

  /** Starts the thread and resolves with its id, or with null when nothing could go or the Mac refused. */
  const submit = async (): Promise<string | null> => {
    if (!controls.canSend || inFlight.current) return null;
    inFlight.current = true;
    setStarting(true);
    const sent = { prompt: draft.prompt.trim(), attachments: draft.images.map((image) => image.path) };
    // As the thread's composer does: the prompt empties at once, and comes back if the Mac refuses.
    const taken = { prompt: draft.prompt, images: draft.images };
    setDraft((current) => ({ ...current, prompt: "", images: [] }));
    field.emptied();
    setError(null);
    try {
      const branchable = await canBranch(host, projectId);
      const toCloud = cloud.place?.chosen === "cloud";
      if (toCloud && !branchable) throw new Error("A cloud thread starts on a branch of its own, and this project has no commit to branch from yet.");
      const workspaceMode = toCloud ? "cloud" : newThreadWorkspaceMode({ canBranch: branchable, chosen: null, preferred: appSettings?.defaultWorkspaceMode });
      const { thread } = await start.mutateAsync(newThreadStartInput(draft, { workspaceMode, permissionMode: permission.permission, ...sent }));
      haptic.confirm();
      unfoldProject(projectId, host);
      return thread.id;
    } catch (error) {
      haptic.fail();
      setDraft((current) => unstarted(taken, current));
      setError(failureMessage(error));
      return null;
    } finally {
      inFlight.current = false;
      setStarting(false);
    }
  };

  return {
    draft,
    setText: (text: string) => {
      if (!field.leftover(text)) change({ prompt: text });
    },
    removeImage: (path: string) => setDraft((current) => ({ ...current, images: current.images.filter((image) => image.path !== path) })),
    uploading,
    chooseImages,
    settings,
    controls,
    starting,
    error: failure?.projectId === projectId ? failure.message : null,
    /** Why Start is dim, once a tap on it asked. */
    dimReason: dim.shown,
    /** A tap on the dim Start: says why it is dim. */
    explainDim: dim.ask,
    submit,
  };
}

/**
 * Where the thread runs, a choice only while the Mac offers cloud threads, for a project, to an agent that runs in a
 * sandbox. Any other thread runs on the Mac, whatever was chosen before.
 */
function useCloudPlace(projectId: string, draft: SheetDraft, change: (patch: Partial<SheetDraft>) => void): Pick<ComposerSettings, "place"> {
  const offer = useRpc("cloud.offer", {});
  const provider = offer.data?.provider;
  if (!provider || projectId === WORKSPACE_ID || draft.target.kind !== "model" || !runsInCloud(draft.target.choice?.agent)) return {};
  return { place: { chosen: draft.workspace === "cloud" ? "cloud" : "mac", provider, select: (place) => change({ workspace: place === "cloud" ? "cloud" : null }) } };
}

/** The desktop's first choice, made from the same reads once they are in and kept with the draft. Returns the Mac's settings. */
function useDefaultChoice(draft: SheetDraft, setDraft: ReturnType<typeof useSheetDraft>[1]) {
  const models = useRpc("agents.models", {}, { staleTime: 5 * 60_000 });
  const harnesses = useRpc("agents.availability", {});
  const appSettings = useRpc("app.settings.get", {});
  useEffect(() => {
    if (draft.target.kind !== "model" || draft.target.choice || !models.data || !harnesses.data || !appSettings.data) return;
    const choice = newThreadChoice(models.data, { preferred: appSettings.data.defaultHarness, harnesses: harnesses.data });
    if (choice) setDraft((current) => ({ ...current, target: { kind: "model", choice } }));
  }, [draft.target, models.data, harnesses.data, appSettings.data, setDraft]);
  return appSettings.data;
}

/**
 * Whether a worktree can branch here, as the desktop's New thread decides it. The phone shows no workspace, so it asks
 * the host's git at every Start: a first commit made since the last read, or a repository removed since, counts.
 */
async function canBranch(host: string | null, projectId: string): Promise<boolean> {
  return projectId !== WORKSPACE_ID && !projectGitView(await hostLink(host).connection.call("projects.git", { id: projectId })).cannotBranch;
}
