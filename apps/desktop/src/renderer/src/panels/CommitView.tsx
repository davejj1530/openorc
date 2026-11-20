import { fileCount, shortSha } from "@openorc/client";
import { lazy, Suspense } from "react";
import { PanelBar, PanelBarMeta } from "../components/PanelBar";
import { Button, Empty } from "../components/ui";
import { useRpc } from "../lib/client";

const DiffView = lazy(() => import("../components/DiffView").then((module) => ({ default: module.DiffView })));

/** One of a thread's commits as its changes against the commit before it, with the way back to the list. */
export function CommitView({ threadId, sha, onBack }: { threadId: string; sha: string; onBack: () => void }) {
  const named = useRpc("git.threadCommit", { threadId, sha });
  // A commit never changes, so its diff is read once.
  const diff = useRpc("review.threadCommitDiff", { threadId, sha }, { staleTime: Infinity });
  const subject = named.data?.commit.subject ?? `Commit ${shortSha(sha)}`;
  return (
    <section className="h-full flex flex-col min-h-0" aria-label={`Commit ${shortSha(sha)}`}>
      <PanelBar title={<span data-tip={subject}>{subject}</span>} meta={diff.data ? <PanelBarMeta>{fileCount(diff.data.files.length)}</PanelBarMeta> : null}>
        <Button variant="ghost" onClick={onBack}>
          All commits
        </Button>
      </PanelBar>
      {diff.error ? (
        <Empty title="Could not read this commit">
          <p role="alert">{diff.error.message}</p>
          <Button className="mt-3" onClick={() => void diff.refetch()}>
            Retry
          </Button>
        </Empty>
      ) : null}
      {!diff.error && !diff.data ? (
        <p role="status" className="px-5 py-2.5 text-sm text-ink-3">
          Loading changes…
        </p>
      ) : null}
      {diff.data && diff.data.files.length === 0 ? <Empty title="No changes" /> : null}
      {diff.data?.files.length ? (
        <div className="flex-1 min-h-0">
          <Suspense fallback={null}>
            <DiffView patch={diff.data.patch} />
          </Suspense>
        </div>
      ) : null}
    </section>
  );
}
