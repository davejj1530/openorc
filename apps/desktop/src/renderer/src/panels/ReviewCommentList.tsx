import { reviewCommentPlace, reviewCommentSent, type ReviewComment } from "@openorc/protocol";
import { X } from "../components/icons";
import type { ReviewCommentState } from "../components/DiffView";
import { TextButton } from "../components/ui";
import { cn } from "../lib/cn";

/** Every review comment in one list, newest last, with removal and optional team selection. */
export function ReviewCommentList({
  comments,
  onRemove,
  commentState,
  selectedIds,
  onSelect,
  selectionLocked,
}: {
  comments: ReviewComment[];
  onRemove: (id: string) => void;
  commentState?: (id: string) => ReviewCommentState;
  selectedIds?: string[];
  onSelect?: (id: string, checked: boolean) => void;
  selectionLocked?: boolean;
}) {
  return (
    <div className="pt-1">
      {comments.map((c) => {
        const state = commentState?.(c.id);
        return (
          <div key={c.id} data-review-comment={c.id} className={cn("px-3 py-1.5 text-sm group", reviewCommentSent(c) && "opacity-60")}>
            <div className="flex items-center gap-1 font-mono text-xs text-ink-4">
              {selectedIds ? (
                <input
                  type="checkbox"
                  aria-label={`Select comment on ${reviewCommentPlace(c)}: ${c.body}`}
                  checked={selectedIds.includes(c.id)}
                  disabled={selectionLocked || state?.removeDisabled || reviewCommentSent(c)}
                  onChange={(event) => onSelect?.(c.id, event.target.checked)}
                  className="shrink-0 mr-1"
                />
              ) : null}
              <span className="truncate">{reviewCommentPlace(c)}</span>
              <span className="flex-1" />
              <TextButton
                onClick={() => onRemove(c.id)}
                disabled={state?.removeDisabled}
                tone="danger"
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 disabled:cursor-default shrink-0"
                aria-label="Remove comment"
                title={state?.reason ?? "Remove"}
              >
                <X size={11} />
              </TextButton>
            </div>
            <div className="text-ink-2 whitespace-pre-wrap">{c.body}</div>
            {state?.label || reviewCommentSent(c) ? <p className="text-xs text-ink-3 mt-0.5">{state?.label ?? "Sent"}</p> : null}
          </div>
        );
      })}
    </div>
  );
}
