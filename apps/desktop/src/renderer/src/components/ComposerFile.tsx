import type { ReactNode } from "react";
import type { Attachment } from "../lib/composer-attachments";
import { cn } from "../lib/cn";
import { formatBytes } from "../lib/file-imports";
import { FileText, X } from "./icons";
import { TextButton } from "./ui";
import "./composer-file.css";

export type ComposerFileState = { kind: "uploading"; percent: number } | { kind: "failed"; message: string; retry: (() => void) | null };

/** Ready files keep the same chip; pending work and refusal belong only to the file concerned. */
export function ComposerFile({
  attachment,
  state,
  remove,
  previewFailed,
  after,
}: {
  attachment: Attachment;
  state?: ComposerFileState;
  remove(): void;
  previewFailed?: () => void;
  /** What the person can do about a refusal, under its words. */
  after?: ReactNode;
}) {
  const chip = (
    <div className="composer-attachment">
      {attachment.url ? (
        <img src={attachment.url} alt={attachment.name} className="composer-thumbnail" onError={previewFailed} />
      ) : (
        <span className="composer-file">
          <FileText size={18} />
          <span className="composer-file-text">
            <span className="composer-file-name" data-tip={attachment.name}>
              {attachment.name}
            </span>
            <FileDetail attachment={attachment} state={state} />
          </span>
        </span>
      )}
      <button type="button" onClick={remove} aria-label={attachment.url ? "Remove image" : `Remove ${attachment.name}`} className="composer-remove-image">
        <X size={11} />
      </button>
    </div>
  );
  if (!state) return chip;
  return (
    <div className={cn("composer-file-state", attachment.url && "composer-file-state-image")}>
      {chip}
      {attachment.url && state.kind === "uploading" ? <FileProgress name={attachment.name} percent={state.percent} image /> : null}
      {attachment.url && state.kind === "failed" && state.retry ? (
        <TextButton tone="muted" className="text-xs" onClick={state.retry}>
          Retry
        </TextButton>
      ) : null}
      {state.kind === "failed" ? (
        <p role="alert" className="composer-file-refusal">
          {state.message}
        </p>
      ) : null}
      {state.kind === "failed" ? after : null}
    </div>
  );
}

function FileDetail({ attachment, state }: { attachment: Attachment; state?: ComposerFileState }) {
  if (state?.kind === "uploading") return <FileProgress name={attachment.name} percent={state.percent} />;
  if (state?.kind === "failed" && state.retry)
    return (
      <TextButton tone="muted" className="text-xs" onClick={state.retry}>
        Retry
      </TextButton>
    );
  return attachment.bytes ? <span className="composer-file-size tabular">{formatBytes(attachment.bytes)}</span> : null;
}

function FileProgress({ name, percent, image = false }: { name: string; percent: number; image?: boolean }) {
  const value = Math.max(0, Math.min(100, Math.floor(percent)));
  const track = (
    <span role="progressbar" aria-label={`Uploading ${name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} className="composer-file-progress-track">
      <span style={{ width: `${value}%` }} />
    </span>
  );
  return (
    <span className={cn("composer-file-progress", image && "composer-file-progress-image")}>
      {image ? track : null}
      <span className="tabular">{image ? `${value}%` : `Uploading ${value}%`}</span>
      {image ? null : track}
    </span>
  );
}
