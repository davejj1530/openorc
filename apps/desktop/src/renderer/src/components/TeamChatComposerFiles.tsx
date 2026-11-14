import { useRef } from "react";
import type { HostedFileScope } from "@openorc/protocol";
import { STORAGE_FULL } from "../lib/team-chat-files";
import { hostedDraftAttachment, useHostedAttachments } from "../lib/use-hosted-attachments";
import { HostedComposerFile } from "./HostedComposerFile";
import { Plus } from "./icons";
import { IconButton, TextButton } from "./ui";

/** Where this conversation's files go, and who may add the organization's storage. */
export interface TeamChatComposerFiles {
  scope: HostedFileScope;
  draftKey: string;
  organization: string;
  /** Present for an admin: opens People at Seats with this draft kept. */
  addSeats?: (() => void) | undefined;
}

/** This conversation's file draft: what is ready to send, why Send waits, and forgetting what a send took. */
export function useTeamChatDraftFiles(place: TeamChatComposerFiles | null) {
  const files = useHostedAttachments(place?.scope ?? null, place?.draftKey);
  const ready = files.files.flatMap((file) => (file.state.kind === "ready" ? [file.state.file] : []));
  return {
    files,
    ready,
    reason: filesReason(files.files),
    sent: () => {
      if (files.files.length) void files.accepted(files.files.map((file) => hostedDraftAttachment(file).path));
    },
  };
}

/** Only this draft's own files hold Send: a refused one until it is retried or removed, one still uploading until done. */
function filesReason(files: readonly { state: { kind: string } }[]): string | null {
  if (files.some((file) => file.state.kind === "failed")) return "Retry or remove the refused file to send.";
  if (files.some((file) => file.state.kind !== "ready")) return "Wait for the files to finish uploading.";
  return null;
}

/** Each attached file with its progress, refusal and retry; a full organization says so in its own name. */
export function TeamChatAttachments({ place, draft }: { place: TeamChatComposerFiles; draft: ReturnType<typeof useTeamChatDraftFiles> }) {
  const { files } = draft;
  if (!files.draft || !files.files.length) return null;
  const refusal = (message: string) => {
    if (message !== STORAGE_FULL) return null;
    const after = place.addSeats ? (
      <TextButton tone="muted" className="text-xs" onClick={place.addSeats}>
        Add seats
      </TextButton>
    ) : (
      <p className="composer-file-hint">Ask an admin to add seats.</p>
    );
    return { message: `${place.organization} is out of storage.`, after };
  };
  return (
    <div className="composer-attachments">
      {files.files.map((file) => (
        <HostedComposerFile
          key={file.id}
          file={file}
          draft={files.draft!}
          retry={() => void files.retry(file)}
          remove={() => void files.remove([hostedDraftAttachment(file).path])}
          refusal={refusal}
        />
      ))}
    </div>
  );
}

/** The plus that chooses files from this Mac for the message. */
export function TeamChatAttach({ onFiles }: { onFiles(files: File[]): void }) {
  const picker = useRef<HTMLInputElement>(null);
  return (
    <>
      <IconButton aria-label="Attach files" size="sm" onClick={() => picker.current?.click()}>
        <Plus size={16} />
      </IconButton>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const chosen = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = "";
          if (chosen.length) onFiles(chosen);
        }}
      />
    </>
  );
}
