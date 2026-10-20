import type { ComposerChanges, ComposerProps } from "./Composer";
import { Folder, GitBranch } from "./icons";
import { Tooltip } from "./ui";

/** Commit and the diff totals share one pill: Commit opens the commit flow, the totals open the review. */
export function ComposerCommitChip({ changes }: { changes: ComposerChanges | null | undefined }) {
  if (!changes || changes.files === 0) return null;
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

/** Where the agent works, under the composer: the folder, the checked-out branch and the uncommitted changes. */
export function ComposerFooter({ location, changes }: Pick<ComposerProps, "location" | "changes">) {
  const changed = Boolean(changes && changes.files > 0);
  if (!location.directory && !location.branch && !changed) return null;
  return (
    <div className="composer-rail">
      {location.directory ? (
        <span className="composer-directory" title={location.directory}>
          <Folder size={14} />
          <span>{location.directory}</span>
        </span>
      ) : null}
      {location.branch || changed ? (
        <div className="composer-git">
          {location.branch ? (
            <span className="composer-branch-chip" title={location.branch}>
              <GitBranch size={13} />
              <span className="composer-branch">{location.branch}</span>
            </span>
          ) : null}
          <ComposerCommitChip changes={changes} />
        </div>
      ) : null}
    </div>
  );
}
