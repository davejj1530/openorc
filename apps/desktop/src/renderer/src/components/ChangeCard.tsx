import { useId, useState, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { Button, IconButton } from "./ui";
import { ChevronDown } from "./icons";
import type { TurnFileChanges } from "@openorc/protocol";

type ChangeFile = TurnFileChanges["files"][number];

export const fileCount = (count: number) => `${count} ${count === 1 ? "file" : "files"}`;

function Counts({ added, removed, className }: { added: number | null; removed: number | null; className?: string }) {
  if (added === null && removed === null) return <span className={cn("change-counts", className)}>Binary</span>;
  return (
    <span className={cn("change-counts", className)}>
      {added ? <span className="change-added">+{added}</span> : null}
      {removed ? <span className="change-removed">−{removed}</span> : null}
      {!added && !removed ? <span>0</span> : null}
    </span>
  );
}

/**
 * One turn's edits as a card closed to one line: "Changed N files" with its totals, Review, and a chevron that opens
 * the files in place. Counts are optional so the card can appear from the tool stream before the saved diff loads.
 */
export function ChangeCard({
  files,
  counted,
  heading,
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
  /** In place of "Changed N files". */
  heading?: string;
  /** Older callers asked for the files folded; every card starts closed now. */
  folded?: boolean;
  note?: string;
  error?: string | null;
  onRetry?: () => void;
  onReview: (paths: string[]) => void;
  /** Extra controls beside Review, such as Undo. */
  actions?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const added = files.reduce((n, file) => n + (file.added ?? 0), 0);
  const removed = files.reduce((n, file) => n + (file.removed ?? 0), 0);
  const listId = useId();
  return (
    <section className={cn("change-card", className)} data-plane aria-label="Code changes">
      <div className="change-heading">
        <span className="change-title">{heading ?? `Changed ${fileCount(files.length)}`}</span>
        {counted ? <Counts added={added} removed={removed} className="change-totals" /> : <span className="change-totals change-counts">Counting…</span>}
        <div className="change-actions">
          {actions}
          <Button size="sm" variant="secondary" onClick={() => onReview(files.map((file) => file.path))}>
            Review
          </Button>
          <IconButton size="xs" aria-label={open ? "Hide files" : `Show ${fileCount(files.length)}`} aria-expanded={open} aria-controls={listId} onClick={() => setOpen((value) => !value)}>
            <ChevronDown size={14} className={cn("change-chevron", open && "rotate-180")} />
          </IconButton>
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
      <div id={listId} className="change-files-wrap" hidden={!open}>
        {open ? (
          <ul className="change-files motion-stagger">
            {files.map((file) => (
              <li key={file.path} className="motion-arrive">
                <button type="button" className="change-file" onClick={() => onReview([file.path])}>
                  {file.path}
                </button>
                {counted ? <Counts added={file.added} removed={file.removed} /> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
