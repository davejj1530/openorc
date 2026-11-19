import { newThreadChoice, newThreadStartInput, newThreadWorkspaceMode, projectGitView, targetModel } from "@openorc/client";
import { WORKSPACE_ID, type RpcParams, type WorkspaceMode } from "@openorc/protocol";
import { useEffect, useRef, useState } from "react";
import { link, useRpc, useRpcMutation } from "../client";
import { composerControls } from "../composer/composer-state";
import { useDimReason } from "../composer/dim-reason";
import { useNewThreadClaudeAccount } from "../composer/claude-account";
import type { ComposerSettings } from "../composer/settings-bridge";
import { useEmptiedPrompt } from "../composer/keyboard-leftover";
import { useCloudFiles } from "../cloud/cloud-files";
import { useImageAttach } from "../composer/use-image-attach";
import { failureMessage } from "../failure";
import { haptic } from "../ui/haptics";
import { useSheetDraft, useSheetPermission } from "./drafts";
import type { ProjectChoice } from "../projects";
import { startBlocker, unstarted, type SheetDraft } from "./new-thread-state";
import { projectReach, useMacReach } from "./project-reach";

/**
 * A new thread in one project, with the desktop's defaults: the model for the Mac's default harness or its first
 * signed-in one, mode act, the Mac's default permission and Claude account until one is chosen here, and the Mac's
 * default workspace where the project can branch. The phone never names a folder: Workspace runs where the Mac's
 * Workspace does. A project only OpenOrc Cloud has starts there, from its space, with no word from the Mac. A start
 * refused keeps the draft and says why.
 */
export function useNewThread(project: ProjectChoice) {
  const projectId = project.id;
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
  // A cloud project's images go to OpenOrc Cloud through the phone's own session, where the server takes files.
  const files = useCloudFiles(project.cloud ? { projectKey: project.id, spaceId: project.cloud.spaceId } : null);
  const attach = useImageAttach({ onImage: (image) => setDraft((current) => ({ ...current, images: [...current.images, image] })), onError: setError, cloud: files.scope });
  const uploading = attach.uploading;
  const chooseImages = project.cloud && !files.scope ? () => void (files.refusal && setError(files.refusal)) : attach.chooseImages;

  const claudeAccountId = useNewThreadClaudeAccount(projectId, draft.claudeAccountId);
  const settings: ComposerSettings = {
    choice: targetModel(draft.target),
    mode: draft.mode,
    permission: permission.permission,
    selectModel: (choice) => change({ target: { kind: "model", choice } }),
    selectExecutionMode: (next) => {
      change({ mode: next.mode });
      permission.select(next.permissionMode);
    },
    ...draftAccounts(project, draft, claudeAccountId, change, starting),
    cloud: Boolean(project.cloud),
  };
  // A Mac project waits for the Mac: Start is held with why, rather than sent to fail.
  const reach = projectReach(project, useMacReach());
  const blocker = startBlocker(draft, { permissionReady: permission.ready }) ?? reach;
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
      const { thread } = await start.mutateAsync(await startInput(project, { ...draft, claudeAccountId }, { permissionMode: permission.permission, ...sent }, appSettings?.defaultWorkspaceMode));
      haptic.confirm();
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
 * The accounts a new thread offers: on OpenOrc Cloud the person's cloud accounts, which take the place of the Mac's
 * Claude accounts; else the Mac's, as its project uses them. Held while the thread starts.
 */
function draftAccounts(
  project: ProjectChoice,
  draft: SheetDraft,
  claudeAccountId: string | undefined,
  change: (patch: Partial<SheetDraft>) => void,
  starting: boolean,
): Pick<ComposerSettings, "claudeAccount" | "cloudAccount"> {
  if (project.cloud) return { cloudAccount: { accountId: draft.cloudAccountId, select: (cloudAccountId) => change({ cloudAccountId }), held: starting ? "Starting the thread…" : null } };
  return { claudeAccount: { chosen: claudeAccountId, select: (id) => change({ claudeAccountId: id }), projectId: project.id } };
}

/** The desktop's first choice, made from the same reads once they are in and kept with the draft. Returns the Mac's settings. */
export function useDefaultChoice(draft: SheetDraft, setDraft: ReturnType<typeof useSheetDraft>[1]) {
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
 * What a start sends: in a cloud project, OpenOrc Cloud in its space, with no Claude account of the Mac's; else the
 * Mac's place for it, as the desktop's New thread chooses one.
 */
async function startInput(
  project: ProjectChoice,
  draft: SheetDraft,
  sent: Pick<RpcParams<"threads.start">, "permissionMode" | "prompt" | "attachments">,
  preferred: WorkspaceMode | undefined,
): Promise<RpcParams<"threads.start">> {
  const { claudeAccountId, ...rest } = draft;
  if (project.cloud) return { ...newThreadStartInput(rest, { ...sent, workspaceMode: "hosted" }), spaceId: project.cloud.spaceId };
  const workspaceMode = newThreadWorkspaceMode({ canBranch: await canBranch(project.id), chosen: null, preferred });
  return newThreadStartInput({ ...rest, ...(claudeAccountId ? { claudeAccountId } : {}) }, { ...sent, workspaceMode });
}

/**
 * Whether a worktree can branch here, as the desktop's New thread decides it. The phone shows no workspace, so it asks
 * the Mac's git at every Start: a first commit made since the last read, or a repository removed since, counts.
 */
async function canBranch(projectId: string): Promise<boolean> {
  return projectId !== WORKSPACE_ID && !projectGitView(await link.connection.call("projects.git", { id: projectId })).cannotBranch;
}
