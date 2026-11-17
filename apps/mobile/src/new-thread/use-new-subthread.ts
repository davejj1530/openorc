import { targetModel, threadDefault } from "@openorc/client";
import { placeOf, type PermissionPreset, type RpcParams, type ThreadSummary } from "@openorc/protocol";
import { useEffect, useRef, useState } from "react";
import { useRpc, useRpcMutation } from "../client";
import { useCloudFiles } from "../cloud/cloud-files";
import { OLDER_MAC_SUBTHREADS } from "../connection/link-connection";
import { useShares } from "../connection/use-shares";
import { composerControls } from "../composer/composer-state";
import { useDimReason } from "../composer/dim-reason";
import { useNewThreadClaudeAccount } from "../composer/claude-account";
import type { ComposerSettings } from "../composer/settings-bridge";
import { useEmptiedPrompt } from "../composer/keyboard-leftover";
import { useImageAttach } from "../composer/use-image-attach";
import { failureMessage } from "../failure";
import { haptic } from "../ui/haptics";
import { useSubthreadDraft } from "./drafts";
import { startBlocker, unstarted, type SheetDraft } from "./new-thread-state";

/** The phone's capability a Mac shares once it starts a thread under another for a phone. */
const SUBTHREAD_STARTS = "subthread-starts";

/** The start a subthread becomes: under its parent, in the parent's folder, so it names no place of its own. */
export function subthreadStartInput(
  parent: Pick<ThreadSummary, "id" | "projectId">,
  draft: SheetDraft,
  input: { permissionMode: PermissionPreset; prompt: string; attachments: string[] },
): RpcParams<"threads.start"> {
  const choice = targetModel(draft.target);
  if (!choice || draft.target.kind !== "model") throw new Error("Choose a model first.");
  return {
    projectId: parent.projectId,
    parentThreadId: parent.id,
    agent: choice.agent,
    model: choice.model,
    effort: choice.effort ?? undefined,
    fastMode: Boolean(choice.fastMode),
    mode: draft.mode,
    permissionMode: input.permissionMode,
    prompt: input.prompt || "See the attached image.",
    attachments: input.attachments,
    ...(draft.claudeAccountId ? { claudeAccountId: draft.claudeAccountId } : {}),
  };
}

/**
 * With nothing chosen and nothing saved on the parent, the parent's own default, as its header shows it: its agent's,
 * from the models the cloud runs for a cloud thread.
 */
function useParentDefault(parent: ThreadSummary, cloud: boolean, draft: SheetDraft, setDraft: ReturnType<typeof useSubthreadDraft>[1]) {
  const models = useRpc("agents.models", {}, { staleTime: 5 * 60_000 });
  const catalog = useRpc("cloudModels.catalog", {}, { enabled: cloud, staleTime: 5 * 60_000 });
  const waiting = cloud && catalog.isPending;
  useEffect(() => {
    if (draft.target.kind !== "model" || draft.target.choice || !models.data || waiting) return;
    const choice = threadDefault(models.data, catalog.data?.models ?? null, parent.agent, cloud);
    if (choice) setDraft((current) => ({ ...current, target: { kind: "model", choice } }));
  }, [draft.target, models.data, catalog.data, waiting, parent.agent, cloud, setDraft]);
}

/**
 * A thread started under `parent`, as the desktop's New subthread starts one: in the parent's folder, on its model,
 * mode, permission and account until they are changed here. The draft is kept per parent, and a start the Mac refuses
 * keeps it and says why.
 */
export function useNewSubthread(parent: ThreadSummary) {
  const [draft, setDraft] = useSubthreadDraft(parent);
  const cloud = placeOf(parent).elsewhere;
  useParentDefault(parent, cloud, draft, setDraft);
  const [permission, setPermission] = useState<PermissionPreset>(parent.permissionMode);
  const start = useRpcMutation("threads.start");
  const [starting, setStarting] = useState(false);
  // A second tap can land before the first start renders, so the start in flight is held here as well.
  const inFlight = useRef(false);
  const field = useEmptiedPrompt();
  const [error, setError] = useState<string | null>(null);
  const change = (patch: Partial<SheetDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  };
  // Under a cloud thread, the subthread is OpenOrc Cloud's too: its images go there through the phone's own session.
  const files = useCloudFiles(cloud ? { threadId: parent.id } : null);
  const attach = useImageAttach({ onImage: (image) => setDraft((current) => ({ ...current, images: [...current.images, image] })), onError: setError, cloud: files.scope });
  const { uploading } = attach;
  const chooseImages = cloud && !files.scope ? () => void (files.refusal && setError(files.refusal)) : attach.chooseImages;
  const claudeAccountId = useNewThreadClaudeAccount(parent.projectId, draft.claudeAccountId);
  // An older Mac starts none for a phone; a cloud thread's own server starts one under it.
  const shared = useShares(SUBTHREAD_STARTS);
  const olderMac = !cloud && shared === false;
  const settings: ComposerSettings = {
    choice: targetModel(draft.target),
    cloud,
    mode: draft.mode,
    permission,
    selectModel: (choice) => change({ target: { kind: "model", choice } }),
    selectExecutionMode: (next) => {
      change({ mode: next.mode });
      setPermission(next.permissionMode);
    },
    claudeAccount: { chosen: claudeAccountId, select: (claudeAccountId) => change({ claudeAccountId }), projectId: parent.projectId },
  };
  const blocker = olderMac ? OLDER_MAC_SUBTHREADS : startBlocker(draft, { permissionReady: true });
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

  /** Starts the subthread and resolves with its id, or with null when nothing could go or the Mac refused. */
  const submit = async (): Promise<string | null> => {
    if (!controls.canSend || inFlight.current) return null;
    inFlight.current = true;
    setStarting(true);
    // As the thread's composer does: the prompt empties at once, and comes back if the Mac refuses.
    const taken = { prompt: draft.prompt, images: draft.images };
    setDraft((current) => ({ ...current, prompt: "", images: [] }));
    field.emptied();
    setError(null);
    try {
      const sent = { permissionMode: permission, prompt: taken.prompt.trim(), attachments: taken.images.map((image) => image.path) };
      const { thread } = await start.mutateAsync(subthreadStartInput(parent, { ...draft, claudeAccountId }, sent));
      haptic.confirm();
      return thread.id;
    } catch (failure) {
      haptic.fail();
      setDraft((current) => unstarted(taken, current));
      setError(failureMessage(failure));
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
    error,
    /** Why Start is dim: said at once for a Mac that cannot start subthreads, else once a tap on it asked. */
    dimReason: olderMac ? OLDER_MAC_SUBTHREADS : dim.shown,
    explainDim: dim.ask,
    submit,
  };
}
