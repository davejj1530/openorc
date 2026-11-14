import { useEffect } from "react";
import type { ThreadSummary } from "@openorc/protocol";
import { Button, Empty } from "../components/ui";
import { useRpc } from "../lib/client";
import { HostedPublish } from "./HostedPublish";

export function HostedCommitsPanel({ thread }: { thread: ThreadSummary }) {
  const read = useRpc("hosted.review.state", { threadId: thread.id });
  const refresh = () => void read.refetch();
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  });
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
      ) : (
        <Empty title="Commit history unavailable">Commit history isn't available in this cloud thread yet.</Empty>
      )}
    </section>
  );
}
