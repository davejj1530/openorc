import { useEffect } from "react";
import { shortSha } from "@openorc/client";
import { HOSTED_REASONS, type HostedThreadCommits, type ThreadSummary } from "@openorc/protocol";
import { Button, Empty } from "../components/ui";
import { useRpc } from "../lib/client";
import { HostedPublish } from "./HostedPublish";
import { HostedUnavailablePanel } from "../components/HostedUnavailablePanel";
import { CommitList } from "./CommitsPanel";
import { useBringable } from "./HostedBring";
import { HostedCommitView } from "./HostedCommitView";

/** The commits newer than the one the thread last pushed: all of them before any push. */
function unpushedOf({ commits, pushed }: HostedThreadCommits): Set<string> {
  const at = pushed === null ? -1 : commits.findIndex((commit) => commit.sha === pushed);
  return new Set((at < 0 ? commits : commits.slice(0, at)).map((commit) => commit.sha));
}

/** A cloud thread's commits, or the one of them `commit` names in place of the list. */
export function HostedCommitsPanel({ thread, commit, onOpen }: { thread: ThreadSummary; commit: string | null; onOpen: (commit: string | null) => void }) {
  const read = useRpc("hosted.review.state", { threadId: thread.id });
  const commits = useRpc("hosted.review.commits", { threadId: thread.id });
  // A project from a folder of a Mac has no remote: its commits are the cloud's until brought here.
  const mac = useBringable(thread.id).data?.mac === true;
  const refresh = () => {
    void read.refetch();
    void commits.refetch();
  };
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  });
  if (read.error?.message === HOSTED_REASONS.publishing) return <HostedUnavailablePanel title="Commits" reason={HOSTED_REASONS.publishing} />;
  const listed = commits.data;
  if (commit) {
    // A commit opened from a reply is known by its id until the list names it.
    const subject = listed?.commits.find((entry) => entry.sha === commit)?.subject ?? `Commit ${shortSha(commit)}`;
    return <HostedCommitView threadId={thread.id} commit={{ sha: commit, subject }} onBack={() => onOpen(null)} />;
  }
  return (
    <section className="h-full flex flex-col min-h-0">
      <HostedPublish thread={thread} state={read.error ? undefined : read.data} stateError={read.error} surface="commits" heading="Commits" />
      {read.error ? (
        <Empty title="Could not read commits">
          <p role="alert">{read.error.message}</p>
          <Button className="mt-3" onClick={refresh}>
            Retry
          </Button>
        </Empty>
      ) : null}
      {!read.error && listed?.commits.length ? (
        <CommitList
          commits={listed.commits}
          unpushed={unpushedOf(listed)}
          unsent={mac ? "In the cloud" : "Not pushed"}
          more={listed.total - listed.commits.length}
          onOpen={(entry) => onOpen(entry.sha)}
        />
      ) : null}
    </section>
  );
}
