import { useCallback, useEffect, useRef, useState } from "react";
import { useLoaded } from "../lib/use-loaded";
import type { HostedFileDraft, HostedFileScope } from "@openorc/protocol";
import { useComposerAttachments, restoreDraftAttachments, type Attachment } from "../lib/composer-attachments";
import { useHostedAttachments, hostedDraftAttachment } from "../lib/use-hosted-attachments";
import { hostedFileReasons } from "../lib/hosted-composer-files";
import { readDraft, removeDraft, writeDraft } from "../lib/drafts";
import { isImagePath } from "../../../shared/image-paths";
import { core } from "../lib/rpc";
import { ComposerFile } from "./ComposerFile";
import { HostedComposerFile } from "./HostedComposerFile";

type Input = { scope?: HostedFileScope | null | undefined; draftKey?: string | undefined; disabledReason?: string | null | undefined };

/** A composer's files: this Mac's attachments as always, or, given a cloud scope, the scoped draft that uploads to it. */
export function useComposerFiles({ scope, draftKey, disabledReason }: Input) {
  const local = useComposerAttachments({ draftKey: scope === undefined ? draftKey : undefined, disabledReason });
  const cloud = useCloudFiles(scope, draftKey);
  if (scope !== undefined) return cloud;
  return {
    ...local,
    blocked: disabledReason,
    pendingReason: null,
    accepted: async (paths: string[]) => local.remove(paths),
    append: (paths: readonly string[]) => restoreDraftAttachments(draftKey, paths.map(returnedAttachment)),
    content: (
      <>
        {local.attachments.map((attachment) => (
          <ComposerFile key={attachment.path} attachment={attachment} remove={() => local.remove([attachment.path])} />
        ))}
        {local.uploading > 0 ? <div className="composer-thumbnail composer-uploading" /> : null}
      </>
    ),
  };
}

function useCloudFiles(scope: HostedFileScope | null | undefined, draftKey: string | undefined) {
  const cloud = useHostedAttachments(scope ?? null, scope ? draftKey : undefined);
  const [error, setError] = useState<string | null>(null);
  const availability = useLoaded(scope?.destination.kind === "hosted" ? JSON.stringify(scope) : null, () => core.call("hostedFiles.availability", { scope: scope! }));
  const recheck = availability.refetch;
  useEffect(() => core.onPush((push) => void (push.type === "invalidate" && push.keys.includes("hostedFiles") && recheck())), [recheck]);
  const reasons = hostedFileReasons({ scope: Boolean(cloud.draft), availability: availability.data, availabilityError: availability.error, files: cloud.files, loading: cloud.loading });
  const blocked = scope?.destination.kind === "chat" ? null : reasons.attach;
  const restore = useReturnedFiles(cloud.draft, draftKey, setError);
  return {
    ...cloud,
    error: error ?? cloud.error,
    blocked,
    pendingReason: reasons.send,
    clearError: () => {
      setError(null);
      cloud.clearError();
    },
    addFiles: async (files: File[]) => {
      if (blocked) return setError(blocked);
      await cloud.addFiles(files);
    },
    // The message is the server's already; a draft that fails to forget its files keeps them, never the send.
    accepted: (paths: string[]) => cloud.accepted(paths).catch(() => undefined),
    append: restore,
    content: cloud.draft
      ? cloud.files.map((file) => (
          <HostedComposerFile key={file.id} file={file} draft={cloud.draft!} retry={() => void cloud.retry(file)} remove={() => cloud.remove([hostedDraftAttachment(file).path])} />
        ))
      : null,
  };
}

/**
 * A queued message edited back into the composer keeps its sent files: their paths are written with the draft before
 * they are restored, so a restore that fails, or waits for the draft, is tried again rather than lost.
 */
function useReturnedFiles(draft: HostedFileDraft | null, draftKey: string | undefined, failed: (message: string) => void) {
  const key = draftKey ? `${draftKey}.returned` : null;
  const running = useRef(false);
  const restore = useCallback(() => {
    if (!draft || !key || running.current) return;
    const paths = readDraft(key, { paths: [] as string[] }).paths;
    if (!paths.length) return;
    running.current = true;
    void core
      .call("hostedFiles.restore", { ...draft, paths })
      .then(
        () => {
          const now = readDraft(key, { paths: [] as string[] }).paths;
          const rest = now.filter((path) => !paths.includes(path));
          if (rest.length) writeDraft(key, { paths: rest });
          else removeDraft(key);
        },
        (error: unknown) => failed(error instanceof Error ? error.message : "These files couldn't go back into the draft. Try again."),
      )
      .finally(() => {
        running.current = false;
      });
  }, [draft, key, failed]);
  useEffect(restore, [restore]);
  return useCallback(
    (paths: readonly string[]) => {
      if (!key || !paths.length) return;
      const kept = readDraft(key, { paths: [] as string[] }).paths;
      writeDraft(key, { paths: [...kept, ...paths.filter((path) => !kept.includes(path))] });
      restore();
    },
    [key, restore],
  );
}

/** A local queued message retains its existing asset path when it returns to the composer. */
function returnedAttachment(path: string): Attachment {
  const stored = path.split(/[\\/]/).pop() ?? path;
  const name = /^[a-f0-9-]{36}-/.test(stored) ? stored.slice(37) : stored;
  return { path, url: isImagePath(path) ? `openorc-asset://attachments/${stored}` : null, name };
}
