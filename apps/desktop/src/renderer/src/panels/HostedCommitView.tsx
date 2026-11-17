import { fileCount, shortSha } from "@openorc/client";
import type { Commit, HostedCommitChanges } from "@openorc/protocol";
import { DiffStat, PanelBar, PanelBarMeta } from "../components/PanelBar";
import { Button, Empty } from "../components/ui";
import { useRpc } from "../lib/client";
import { HostedReviewFiles } from "./HostedReviewFiles";

/** One of a cloud thread's commits as its changes against the commit before it, with the way back to the list. */
export function HostedCommitView({ threadId, commit, onBack }: { threadId: string; commit: Pick<Commit, "sha" | "subject">; onBack: () => void }) {
  const read = useRpc("hosted.review.commit", { threadId, sha: commit.sha });
  const changes = read.error ? undefined : read.data;
  return (
    <section className="h-full flex flex-col min-h-0" aria-label={`Commit ${shortSha(commit.sha)}`}>
      <PanelBar
        title={<span data-tip={commit.subject}>{commit.subject}</span>}
        meta={
          changes ? (
            <>
              <PanelBarMeta>{fileCount(changes.totals.files)}</PanelBarMeta>
              <DiffStat add={changes.totals.insertions} del={changes.totals.deletions} />
            </>
          ) : null
        }
      >
        <Button variant="ghost" onClick={onBack}>
          All commits
        </Button>
      </PanelBar>
      {read.error ? (
        <Empty title="Could not read this commit">
          <p role="alert">{read.error.message}</p>
          <Button className="mt-3" onClick={() => void read.refetch()}>
            Retry
          </Button>
        </Empty>
      ) : (
        <CommitChanges threadId={threadId} changes={changes} />
      )}
    </section>
  );
}

function CommitChanges({ threadId, changes }: { threadId: string; changes: HostedCommitChanges | undefined }) {
  if (!changes)
    return (
      <p role="status" className="px-5 py-2.5 text-sm text-ink-3">
        Loading changes…
      </p>
    );
  if (changes.files.length === 0 && changes.unlisted === 0) return <Empty title="No changes" />;
  return <HostedReviewFiles key={changes.sha} threadId={threadId} changes={changes} commit={changes.sha} />;
}
