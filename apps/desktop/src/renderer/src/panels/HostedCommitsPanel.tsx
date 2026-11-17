import { useEffect, useState } from "react";
import { HOSTED_REASONS, type Commit, type HostedThreadCommits, type ThreadSummary } from "@openorc/protocol";
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

export function HostedCommitsPanel({ thread }: { thread: ThreadSummary }) {
  const read = useRpc("hosted.review.state", { threadId: thread.id });
  const commits = useRpc("hosted.review.commits", { threadId: thread.id });
  // A project from a folder of a Mac has no remote: its commits are the cloud's until brought here.
  const mac = useBringable(thread.id).data?.mac === true;
  // The commit open, for the thread it was opened in.
  const [open, setOpen] = useState<{ threadId: string; commit: Commit } | null>(null);
  const refresh = () => {
    void read.refetch();
    void commits.refetch();
  };
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  });
  if (read.error?.message === HOSTED_REASONS.publishing) return <HostedUnavailablePanel title="Commits" control="publishing" />;
  if (open?.threadId === thread.id) return <HostedCommitView threadId={thread.id} commit={open.commit} onBack={() => setOpen(null)} />;
  const listed = commits.data;
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
          onOpen={(commit) => setOpen({ threadId: thread.id, commit })}
        />
      ) : null}
    </section>
  );
}
