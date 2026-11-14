import type { ReactNode } from "react";
import type { HostedDraftFile, HostedFileDraft } from "@openorc/protocol";
import { isImageAttachment } from "../lib/file-imports";
import { useHostedAsset } from "../lib/use-hosted-asset";
import { hostedDraftAttachment } from "../lib/use-hosted-attachments";
import { ComposerFile, type ComposerFileState } from "./ComposerFile";

export function HostedComposerFile({
  file,
  draft,
  retry,
  remove,
  refusal,
}: {
  file: HostedDraftFile;
  draft: HostedFileDraft;
  retry(): void;
  remove(): void;
  /** A destination's own words for a refusal and what can be done about it. */
  refusal?: (message: string) => { message: string; after?: ReactNode } | null;
}) {
  const image = isImageAttachment({ name: file.name, type: file.mime });
  const preview = useHostedAsset(image && file.imported === file.bytes ? { kind: "draft", ref: { ...draft, id: file.id } } : null);
  const attachment = { ...hostedDraftAttachment(file), url: preview.state.kind === "ready" ? preview.state.url : null };
  const state = fileState(file, retry);
  const own = state?.kind === "failed" ? refusal?.(state.message) : null;
  return (
    <ComposerFile attachment={attachment} state={own && state?.kind === "failed" ? { ...state, message: own.message } : state} remove={remove} previewFailed={preview.failed} after={own?.after} />
  );
}

function fileState(file: HostedDraftFile, retry: () => void): ComposerFileState | undefined {
  const state = file.state;
  switch (state.kind) {
    case "ready":
      return undefined;
    case "failed":
      return { kind: "failed", message: state.message, retry: state.retryable ? retry : null };
    case "importing":
      return { kind: "uploading", percent: 0 };
    case "uploading":
      return { kind: "uploading", percent: file.bytes ? (state.sent / file.bytes) * 100 : 0 };
  }
}
