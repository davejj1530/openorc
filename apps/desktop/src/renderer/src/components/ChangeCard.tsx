import { useState, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { Button } from "./ui";
import { ChevronDown, Pencil } from "./icons";
import type { TurnFileChanges } from "@openorc/protocol";

type ChangeFile = TurnFileChanges["files"][number];

/** How many files show before the rest fold behind "Show more". */
const VISIBLE_FILES = 3;

/** A file as a path in a quieter tone and its name in the reading tone, the way the agent apps list edits. */
function FileName({ path }: { path: string }) {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? (
    <strong>{path}</strong>
  ) : (
    <>
      {path.slice(0, slash + 1)}
      <strong>{path.slice(slash + 1)}</strong>
    </>
  );
}

function Counts({ added, removed }: { added: number | null; removed: number | null }) {
  if (added === null && removed === null) return <span className="change-counts text-ink-3">Binary</span>;
  return (
    <span className="change-counts">
      <span className="text-ok">+{added ?? 0}</span>
      <span className="text-bad">−{removed ?? 0}</span>
    </span>
  );
}

/**
 * One turn's edits: a heading with totals, the first few files, and the rest on request.
 * Counts are optional so the card can appear from the tool stream before the saved diff loads.
 */
export function ChangeCard({
  files,
  counted,
  note,
  error,
  onRetry,
  onReview,
  actions,
  className,
}: {
  files: ChangeFile[];
  /** The saved diff has been read; counts are real rather than pending. */
  counted: boolean;
  note?: string;
  error?: string | null;
  onRetry?: () => void;
  onReview: (paths: string[]) => void;
  /** Extra controls beside Review, such as Undo. */
  actions?: ReactNode;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const added = files.reduce((n, file) => n + (file.added ?? 0), 0);
  const removed = files.reduce((n, file) => n + (file.removed ?? 0), 0);
  const shown = expanded ? files : files.slice(0, VISIBLE_FILES);
  const hidden = files.length - shown.length;
  return (
    <section className={cn("change-card", className)} aria-label="Code changes">
      <div className="change-heading">
        <span className="change-icon" aria-hidden>
          <Pencil size={16} />
        </span>
        <div className="change-title">
          <strong>
            Edited {files.length} {files.length === 1 ? "file" : "files"}
          </strong>
          {counted ? <Counts added={added} removed={removed} /> : <span className="change-counts text-ink-3">Counting…</span>}
        </div>
        <div className="change-actions">
          {actions}
          <Button size="sm" onClick={() => onReview(files.map((file) => file.path))}>
            Review
          </Button>
        </div>
      </div>
      {note ? <p className="change-note">{note}</p> : null}
      {error ? (
        <p className="change-error text-bad" role="alert">
          {error}
          {onRetry ? (
            <>
              {" "}
              <button type="button" className="underline" onClick={onRetry}>
                Retry
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      <ul className="change-files">
        {shown.map((file) => (
          <li key={file.path}>
            <button type="button" className="text-left hover:underline" onClick={() => onReview([file.path])}>
              <FileName path={file.path} />
            </button>
            {counted ? <Counts added={file.added} removed={file.removed} /> : null}
          </li>
        ))}
      </ul>
      {hidden > 0 || (expanded && files.length > VISIBLE_FILES) ? (
        <button type="button" className="change-more" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show fewer files" : `Show ${hidden} more ${hidden === 1 ? "file" : "files"}`}
          <ChevronDown size={14} className={cn("transition-transform", expanded && "rotate-180")} />
        </button>
      ) : null}
    </section>
  );
}
