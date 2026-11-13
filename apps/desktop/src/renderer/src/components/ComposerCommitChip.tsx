import type { ComposerChanges } from "./Composer";
import { Tooltip } from "./ui";

/** A conversation's Commit chip, over the composer's left edge; the row folds away while there is nothing to commit. */
export function ComposerChangesBar({ changes }: { changes: ComposerChanges | null | undefined }) {
  return (
    <div className="composer-changes-bar empty:hidden">
      <ComposerCommitChip changes={changes} />
    </div>
  );
}

/** Commit and the diff totals share one pill: Commit opens the commit flow, the totals open the review. While the panel shows the changes, its Commit is the one. */
export function ComposerCommitChip({ changes }: { changes: ComposerChanges | null | undefined }) {
  if (!changes || changes.files === 0 || changes.inPanel) return null;
  const fileLabel = changes.files === 1 ? "file" : "files";
  return (
    <section className="composer-changes" aria-label="Uncommitted changes">
      <Tooltip label={changes.commitDisabledReason ?? "Commit changes"}>
        <span className="composer-changes-commit-wrap">
          <button type="button" className="composer-changes-commit" aria-label="Commit changes" disabled={Boolean(changes.commitDisabledReason)} onClick={changes.onCommit}>
            Commit
          </button>
        </span>
      </Tooltip>
      <button
        type="button"
        className="composer-changes-summary"
        onClick={changes.onReview}
        aria-label={`Review ${changes.files} changed ${fileLabel}, ${changes.insertions} added and ${changes.deletions} removed lines`}
      >
        {changes.insertions + changes.deletions > 0 ? (
          <>
            {changes.insertions > 0 ? <span className="text-ok">+{changes.insertions.toLocaleString()}</span> : null}
            {changes.deletions > 0 ? <span className="text-bad">−{changes.deletions.toLocaleString()}</span> : null}
          </>
        ) : (
          <span>
            {changes.files} {fileLabel}
          </span>
        )}
      </button>
    </section>
  );
}
