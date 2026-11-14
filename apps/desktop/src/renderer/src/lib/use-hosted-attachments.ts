import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { hostedFilePath, type HostedDraftFile, type HostedFileDraft, type HostedFileScope } from "@openorc/protocol";
import { hostedAttachments } from "./hosted-attachment-runtime";
import { hostedAttachmentKey } from "./hosted-attachment-store";
import { organizationContentGate, startOrganizationContentGate } from "./organization-content-gate";
import { core } from "./rpc";
import { writeDraft } from "./drafts";
import type { Attachment } from "./composer-attachments";

const NONE: HostedDraftFile[] = [];
const subscribeNothing = () => () => {};
const WAITING = "Wait for this file to finish uploading.";

export function hostedDraftAttachment(file: HostedDraftFile): Attachment {
  return { path: file.state.kind === "ready" ? hostedFilePath(file.state.file) : `hosted-draft:${file.id}`, name: file.name, bytes: file.bytes, url: null };
}

/** A hosted draft has its own durable source; local attachment validation and storage remain untouched. */
export function useHostedAttachments(scope: HostedFileScope | null, draftKey?: string) {
  const draft = useMemo(() => (scope && draftKey ? { scope, draftKey } : null), [scope, draftKey]);
  const key = draft ? hostedAttachmentKey(draft) : null;
  const authority = useSyncExternalStore(draft ? organizationContentGate.subscribe : subscribeNothing, organizationContentGate.getSnapshot);
  const allowed = Boolean(draft && organizationContentGate.status(draft.scope.spaceId).allowed);
  const [actionError, setActionError] = useState<string | null>(null);
  useEffect(() => (draft ? startOrganizationContentGate() : undefined), [draft]);
  const query = useQuery({
    queryKey: ["hosted-attachments", key, authority.generation],
    enabled: Boolean(draft && allowed),
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
    queryFn: async () => {
      if (!draft) throw new Error("Choose a cloud destination first.");
      const captured = await hostedAttachments.capture(draft);
      return { draft: captured, files: await hostedAttachments.files(captured) };
    },
  });
  const refresh = query.refetch;
  useEffect(() => {
    if (!draft || !allowed) return;
    const changed = () => {
      void refresh();
    };
    const source = hostedAttachments.subscribe(changed);
    const push = core.onPush((event) => {
      if (event.type === "invalidate" && event.keys.includes("hostedFiles")) changed();
    });
    return () => {
      source();
      push();
    };
  }, [draft, allowed, refresh]);
  const files = allowed ? (query.data?.files ?? NONE) : NONE;
  const attachments = useMemo(() => files.map(hostedDraftAttachment), [files]);
  useEffect(() => {
    if (draftKey && scope) writeDraft(draftKey, { attachments });
  }, [draftKey, scope, attachments]);
  const captured = query.data?.draft ?? draft;
  const action = useCallback(
    (work: (draft: HostedFileDraft) => Promise<void>) => {
      if (!captured) return Promise.reject(new Error("Choose a cloud destination first."));
      setActionError(null);
      return work(captured).catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : "This file couldn't be saved. Try again.");
      });
    },
    [captured],
  );
  const remove = useCallback(
    (paths: string[]) => {
      void action(async (draft) => {
        for (const file of files) if (paths.includes(hostedDraftAttachment(file).path)) await hostedAttachments.remove({ ...draft, id: file.id });
      });
    },
    [files, action],
  );
  const accepted = useCallback(
    async (paths: string[]) => {
      if (!captured) return;
      for (const file of files) if (paths.includes(hostedDraftAttachment(file).path)) await hostedAttachments.accepted({ ...captured, id: file.id });
    },
    [captured, files],
  );
  return {
    draft: captured,
    files,
    attachments,
    remove,
    accepted,
    uploading: files.filter((file) => file.state.kind !== "ready").length,
    blocked: query.error?.message ?? (query.isLoading ? WAITING : null),
    error: actionError,
    clearError: () => setActionError(null),
    addFiles: (chosen: File[]) =>
      action(async (draft) => {
        const ready = await hostedAttachments.capture(draft);
        for (const file of chosen) await hostedAttachments.add(ready, file, file.name || "Attached file");
      }),
    retry: (file: HostedDraftFile) => action((draft) => hostedAttachments.retry({ ...draft, id: file.id })),
  };
}
